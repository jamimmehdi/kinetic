//! Pointer movement processing: DPI stages, X/Y sensitivity, acceleration, rotation, angle snapping
//! and smoothing, plus live measurements (polling rate, speed, latency).
//!
//! How it works: the low-level hook swallows the mouse's own movement and the Raw Input handler
//! turns the raw counts into processed movement, which it injects. Nothing is swallowed until the
//! first raw movement has been seen, so a failure to get raw input can never freeze the pointer.
//! When the profile needs no processing at all, the mouse moves natively and this module is idle.

use crate::accel::Curve;
use crate::config::{self, Perf};
use crate::{bus, hook, razer, spi, state};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Movement is being processed in software.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);
/// The hook may swallow the mouse's own movement.
pub static SWALLOW: AtomicBool = AtomicBool::new(false);

static STAGE: AtomicUsize = AtomicUsize::new(1);
const NO_HOLD: usize = usize::MAX;
static HOLD: AtomicUsize = AtomicUsize::new(NO_HOLD);
/// The starting stage the active profile had the last time we looked, to notice edits to it.
static CONFIG_STAGE: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Angle, in degrees, within which a stroke is snapped onto an axis.
const SNAP_DEGREES: f32 = 6.0;
/// Hardest smoothing the processor applies, whatever the setting says.
const MAX_SMOOTHING: f32 = 0.8;

/// A DPI the user set on the mouse itself (its own DPI button) that the stage list does not describe.
static EXTERNAL: Mutex<Option<(u32, u32)>> = Mutex::new(None);

pub struct Processor {
    perf: Perf,
    curve: Curve,
    sx: f32,
    sy: f32,
    cos: f32,
    sin: f32,
    speed: f32,
    speed_x: f32,
    speed_y: f32,
    dir: (f32, f32),
    pending: (f32, f32),
    rem: (f32, f32),
    pub last_mult: f32,
}

impl Processor {
    #[cfg(test)]
    pub fn new(perf: &Perf, stage: usize) -> Processor {
        Processor::build(perf, perf.stage_dpi(stage), perf.native_dpi)
    }

    /// `target` is the DPI the user wants, `native_dpi` what the mouse actually runs at.
    pub fn build(perf: &Perf, target: (u32, u32), native_dpi: u32) -> Processor {
        let (dx, dy) = target;
        let native = native_dpi.max(1) as f32;
        let rad = perf.rotation.to_radians();
        Processor {
            perf: perf.clone(),
            curve: Curve::build(&perf.accel),
            sx: dx as f32 / native,
            sy: dy as f32 / native * perf.y_ratio,
            cos: rad.cos(),
            sin: rad.sin(),
            speed: 0.0,
            speed_x: 0.0,
            speed_y: 0.0,
            dir: (0.0, 0.0),
            pending: (0.0, 0.0),
            rem: (0.0, 0.0),
            last_mult: 1.0,
        }
    }

    /// Turns one raw movement into whole pixels to inject. `dt_ms` is the time since the previous one.
    pub fn process(&mut self, dx: i32, dy: i32, dt_ms: f32) -> (i32, i32) {
        let dt = dt_ms.clamp(0.25, 100.0);
        let idle = dt_ms > 50.0;
        let (mut fx, mut fy) = (dx as f32, dy as f32);

        if self.perf.angle_snap {
            if idle {
                self.dir = (0.0, 0.0);
            }
            self.dir = (self.dir.0 * 0.85 + fx, self.dir.1 * 0.85 + fy);
            let (ax, ay) = (self.dir.0.abs(), self.dir.1.abs());
            if ax + ay > 4.0 {
                let angle = ay.atan2(ax).to_degrees();
                if angle < SNAP_DEGREES {
                    fy = 0.0;
                } else if angle > 90.0 - SNAP_DEGREES {
                    fx = 0.0;
                }
            }
        }

        // Hand speed in counts per ms, smoothed over a few events so one odd gap does not jolt it.
        let inst = fx.hypot(fy) / dt;
        let blend = |old: f32, new: f32| if idle { new } else { 0.6 * old + 0.4 * new };
        self.speed = blend(self.speed, inst);
        self.speed_x = blend(self.speed_x, fx.abs() / dt);
        self.speed_y = blend(self.speed_y, fy.abs() / dt);

        let (mx, my) = if self.perf.accel.per_axis {
            (self.curve.multiplier(self.speed_x), self.curve.multiplier(self.speed_y))
        } else {
            let m = self.curve.multiplier(self.speed);
            (m, m)
        };
        self.last_mult = if self.perf.accel.per_axis { (mx + my) * 0.5 } else { mx };

        let (ox, oy) = (fx * self.sx * mx, fy * self.sy * my);
        let (rx, ry) = (ox * self.cos - oy * self.sin, ox * self.sin + oy * self.cos);

        // Smoothing holds back part of the movement and delivers it with the next events. Anything
        // still held after a pause is released at once, so the total distance never changes.
        let s = self.perf.smoothing.min(MAX_SMOOTHING);
        let (px, py) = (self.pending.0 + rx, self.pending.1 + ry);
        let (sx, sy) = if s > 0.0 && !idle { (px * (1.0 - s), py * (1.0 - s)) } else { (px, py) };
        self.pending = (px - sx, py - sy);

        let (tx, ty) = (self.rem.0 + sx, self.rem.1 + sy);
        let (ix, iy) = (tx.trunc(), ty.trunc());
        self.rem = (tx - ix, ty - iy);
        (ix as i32, iy as i32)
    }
}

// ---- engine state -----------------------------------------------------------------------------

static PROCESSOR: Mutex<Option<Processor>> = Mutex::new(None);

/// The DPI in use: what the mouse itself was set to, or the current stage's.
fn target_dpi(perf: &Perf, stage: usize) -> (u32, u32) {
    EXTERNAL.lock().ok().and_then(|e| *e).unwrap_or_else(|| perf.stage_dpi(stage))
}

/// What the mouse really runs at: its own reading when a supported mouse is connected.
fn native_dpi(perf: &Perf) -> u32 {
    razer::hardware_dpi().map(|d| d.0).unwrap_or(perf.native_dpi)
}

pub fn effective_stage(perf: &Perf) -> usize {
    let hold = HOLD.load(Ordering::Relaxed);
    let s = if hold != NO_HOLD { hold } else { STAGE.load(Ordering::Relaxed) };
    s.min(perf.stages.len().saturating_sub(1))
}

fn active_perf() -> Perf {
    config::current().perf_for(&config::active_profile())
}

/// Rebuild everything from the live config. Call after the config, the active profile or the
/// DPI stage changes.
pub fn apply_config() {
    let perf = active_perf();
    let stage = effective_stage(&perf);
    let target = target_dpi(&perf, stage);
    let paused = state::paused();

    // With a supported mouse, ask it to run at the wanted DPI itself. Software scaling then only
    // covers whatever the mouse is not (yet) at.
    if perf.use_hardware && !paused && razer::connected() {
        razer::request_dpi(target.0, target.1);
    }
    let native = native_dpi(&perf);
    let want = perf.needs_movement_for(target, native) && !paused;

    if let Ok(mut p) = PROCESSOR.lock() {
        *p = if want { Some(Processor::build(&perf, target, native)) } else { None };
    }
    let was = ACTIVE.swap(want, Ordering::Relaxed);
    if !want || !was {
        // Wait for a fresh raw movement before swallowing anything.
        SWALLOW.store(false, Ordering::Relaxed);
    }
    spi::set_accel_off(want && perf.raw_movement);
    spi::set_scroll_lines(if state::paused() { None } else { Some(perf.scroll.lines) });
    bus::publish(&dpi_event());
}

/// The active profile changed: go back to its own starting DPI stage.
pub fn on_profile_changed() {
    let start = active_perf().active_stage;
    clear_external();
    HOLD.store(NO_HOLD, Ordering::Relaxed);
    STAGE.store(start, Ordering::Relaxed);
    CONFIG_STAGE.store(start, Ordering::Relaxed);
    apply_config();
}

/// The config was replaced. If the user changed the profile's starting stage, switch to it;
/// otherwise keep the stage chosen with the buttons.
pub fn on_config_replaced() {
    let start = active_perf().active_stage;
    if CONFIG_STAGE.swap(start, Ordering::Relaxed) != start {
        clear_external();
        HOLD.store(NO_HOLD, Ordering::Relaxed);
        STAGE.store(start, Ordering::Relaxed);
    }
    apply_config();
}

fn clear_external() {
    if let Ok(mut e) = EXTERNAL.lock() {
        *e = None;
    }
}

/// The user pressed the mouse's own DPI button. If the new DPI is one of the stages, the app's
/// stage follows it; otherwise the app shows the mouse's DPI as it is.
pub fn on_hardware_dpi(x: u32, y: u32) {
    let perf = active_perf();
    HOLD.store(NO_HOLD, Ordering::Relaxed);
    match perf.stages.iter().position(|s| s.dpi == x) {
        Some(i) if perf.stage_dpi(i) == (x, y) => {
            clear_external();
            STAGE.store(i, Ordering::Relaxed);
        }
        _ => {
            if let Ok(mut e) = EXTERNAL.lock() {
                *e = Some((x, y));
            }
        }
    }
    apply_config();
}

pub fn dpi_event() -> serde_json::Value {
    let perf = active_perf();
    let stage = effective_stage(&perf);
    let (x, y) = target_dpi(&perf, stage);
    let custom = EXTERNAL.lock().ok().is_some_and(|e| e.is_some());
    json!({
        "t": "dpi", "stage": stage, "dpi_x": x, "dpi_y": y, "native": native_dpi(&perf),
        "stages": perf.stages.len(), "processing": ACTIVE.load(Ordering::Relaxed),
        "hardware": razer::connected() && perf.use_hardware, "custom": custom,
    })
}

pub fn set_stage(stage: usize) {
    clear_external();
    let n = active_perf().stages.len();
    STAGE.store(stage.min(n.saturating_sub(1)), Ordering::Relaxed);
    apply_config();
}

pub fn step_stage(forward: bool, wrap: bool) {
    clear_external();
    let perf = active_perf();
    let n = perf.stages.len();
    let cur = effective_stage(&perf);
    let next = if forward {
        if cur + 1 < n { cur + 1 } else if wrap { 0 } else { cur }
    } else if cur > 0 {
        cur - 1
    } else if wrap {
        n - 1
    } else {
        cur
    };
    STAGE.store(next, Ordering::Relaxed);
    apply_config();
}

/// Use `stage` while a button is held, then go back.
pub fn hold_stage(stage: Option<usize>) {
    clear_external();
    HOLD.store(stage.unwrap_or(NO_HOLD), Ordering::Relaxed);
    apply_config();
}

// ---- raw movement ------------------------------------------------------------------------------

pub struct RawMove {
    pub dx: i32,
    pub dy: i32,
    pub relative: bool,
    /// Came from a real device, not from injected input (ours or anyone else's).
    pub from_device: bool,
}

struct Stats {
    dts: [u32; 48],
    count: usize,
    last: Option<Instant>,
    hz: f32,
    speed: f32,
    latency_us: f32,
    mult: f32,
    last_event: Option<Instant>,
}

static STATS: Mutex<Stats> = Mutex::new(Stats {
    dts: [0; 48],
    count: 0,
    last: None,
    hz: 0.0,
    speed: 0.0,
    latency_us: 0.0,
    mult: 1.0,
    last_event: None,
});

/// Moves we sent that the hook has not yet seen come back. Software that blocks injected input
/// (some anti-cheat drivers) leaves this growing, and a swallowed mouse would then never move.
static SENT_UNSEEN: AtomicU32 = AtomicU32::new(0);
const BLOCKED_AFTER: u32 = 60;

pub fn note_injected_seen() {
    SENT_UNSEEN.store(0, Ordering::Relaxed);
}

/// Called for every movement from a real device.
pub fn on_raw(m: RawMove) {
    if !m.from_device || !m.relative || (m.dx == 0 && m.dy == 0) || state::paused() {
        return;
    }
    let started = Instant::now();
    let dt_ms = note_stats(m.dx, m.dy, started);

    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    if !SWALLOW.swap(true, Ordering::Relaxed) {
        // First movement after activation passes through natively; later ones are swallowed.
        return;
    }
    let out = match PROCESSOR.lock() {
        Ok(mut g) => g.as_mut().map(|p| (p.process(m.dx, m.dy, dt_ms), p.last_mult)),
        Err(_) => None,
    };
    let Some(((ix, iy), mult)) = out else { return };
    if ix != 0 || iy != 0 {
        hook::send(&[hook::move_input(ix, iy)]);
        if SENT_UNSEEN.fetch_add(1, Ordering::Relaxed) + 1 >= BLOCKED_AFTER && !hook::test_mode() {
            // Injection is being dropped. Step aside so the physical mouse works again; the engine
            // tries again when another window comes to the front.
            SENT_UNSEEN.store(0, Ordering::Relaxed);
            state::set_blocked();
            return;
        }
    }
    if let Ok(mut s) = STATS.lock() {
        let took = started.elapsed().as_micros() as f32;
        s.latency_us = if s.latency_us == 0.0 { took } else { s.latency_us * 0.9 + took * 0.1 };
        s.mult = mult;
    }
}

/// Updates the live measurements and returns the time since the previous movement in ms.
fn note_stats(dx: i32, dy: i32, now: Instant) -> f32 {
    let Ok(mut s) = STATS.lock() else { return 1.0 };
    let dt = match s.last {
        Some(prev) => now.duration_since(prev),
        None => Duration::from_millis(100),
    };
    s.last = Some(now);
    s.last_event = Some(now);
    let dt_us = dt.as_micros().min(u32::MAX as u128) as u32;
    let dt_ms = (dt_us as f32 / 1000.0).max(0.05);

    // Polling rate: the typical gap between events while the mouse is moving steadily.
    if dt_us < 20_000 {
        let i = s.count % s.dts.len();
        s.dts[i] = dt_us;
        s.count += 1;
        if s.count >= 16 && s.count % 8 == 0 {
            let n = s.count.min(s.dts.len());
            let mut v: Vec<u32> = s.dts[..n].to_vec();
            v.sort_unstable();
            let median = v[n / 2].max(1) as f32;
            s.hz = 1_000_000.0 / median;
        }
    }
    let inst = (dx as f32).hypot(dy as f32) / dt_ms.max(0.25);
    s.speed = if dt_us > 50_000 { inst } else { s.speed * 0.7 + inst * 0.3 };
    dt_ms
}

/// Publishes live numbers a few times a second while the mouse is moving.
pub fn start_telemetry() {
    std::thread::spawn(|| {
        let mut idle_sent = false;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let Ok(s) = STATS.lock() else { continue };
            let moving = s.last_event.is_some_and(|t| t.elapsed() < Duration::from_millis(400));
            if !moving && idle_sent {
                continue;
            }
            idle_sent = !moving;
            let value = json!({
                "t": "telemetry",
                "speed": if moving { s.speed } else { 0.0 },
                "hz": s.hz.round(),
                "latency_ms": (s.latency_us / 10.0).round() / 100.0,
                "mult": s.mult,
                "moving": moving,
            });
            drop(s);
            bus::publish(&value);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Accel, AccelMode, Stage};

    fn perf() -> Perf {
        Perf::default()
    }

    // Indexes in the default stage list: 400, 800, 1200, 1600, 2400, 3200.
    const LOW: usize = 1; // 800
    const NATIVE: usize = 3; // 1600
    const HIGH: usize = 5; // 3200

    fn run(p: &mut Processor, moves: &[(i32, i32)]) -> (i32, i32) {
        moves.iter().fold((0, 0), |acc, &(dx, dy)| {
            let (ox, oy) = p.process(dx, dy, 1.0);
            (acc.0 + ox, acc.1 + oy)
        })
    }

    #[test]
    fn native_sensitivity_passes_movement_through() {
        let mut p = Processor::new(&perf(), NATIVE);
        assert_eq!(run(&mut p, &[(3, -4), (10, 0), (0, 7)]), (13, 3));
    }

    #[test]
    fn stage_dpi_scales_movement() {
        // Stage 2 is 3200 DPI on a 1600 DPI mouse: double.
        let mut p = Processor::new(&perf(), HIGH);
        assert_eq!(run(&mut p, &[(5, 5), (1, 0)]), (12, 10));
        // Stage 0 is 800 DPI: half, with the leftover carried between events.
        let mut h = Processor::new(&perf(), LOW);
        assert_eq!(run(&mut h, &[(1, 1), (1, 1), (1, 1), (1, 1)]), (2, 2));
    }

    #[test]
    fn independent_xy_uses_separate_dpi() {
        let mut pf = perf();
        pf.independent_xy = true;
        pf.stages[NATIVE].dpi_y = Some(800);
        let mut p = Processor::new(&pf, NATIVE);
        assert_eq!(run(&mut p, &[(10, 10)]), (10, 5));
    }

    #[test]
    fn y_ratio_scales_only_vertical() {
        let mut pf = perf();
        pf.y_ratio = 0.5;
        let mut p = Processor::new(&pf, NATIVE);
        assert_eq!(run(&mut p, &[(10, 10)]), (10, 5));
    }

    #[test]
    fn rotation_turns_movement_clockwise_on_screen() {
        let mut pf = perf();
        pf.rotation = 90.0;
        let mut p = Processor::new(&pf, NATIVE);
        let (x, y) = run(&mut p, &[(10, 0)]);
        assert!(x.abs() <= 1 && (y - 10).abs() <= 1, "got ({x}, {y})");
    }

    #[test]
    fn acceleration_boosts_fast_movement_only() {
        let mut pf = perf();
        pf.accel = Accel { mode: AccelMode::Linear, rate: 0.5, limit: 4.0, ..Accel::default() };
        let mut slow = Processor::new(&pf, NATIVE);
        let mut fast = Processor::new(&pf, NATIVE);
        // 1 count per ms is slow, 8 counts per ms is fast.
        let s: i32 = (0..20).map(|_| slow.process(1, 0, 1.0).0).sum();
        let f: i32 = (0..20).map(|_| fast.process(8, 0, 1.0).0).sum();
        assert!(s >= 20 && s < 40, "slow total {s}");
        assert!(f > 160 * 2, "fast total {f}");
    }

    #[test]
    fn angle_snapping_straightens_near_horizontal_strokes() {
        let mut pf = perf();
        pf.angle_snap = true;
        let mut p = Processor::new(&pf, NATIVE);
        // A wobbly horizontal stroke: the stray vertical counts are removed.
        let (x, y) = run(&mut p, &[(10, 1), (10, 0), (10, -1), (10, 1), (10, 0), (10, 1)]);
        assert_eq!(x, 60);
        assert_eq!(y, 0);
        // A clearly diagonal stroke is untouched.
        let mut d = Processor::new(&pf, NATIVE);
        let (dx, dy) = run(&mut d, &[(10, 10), (10, 10), (10, 10)]);
        assert_eq!((dx, dy), (30, 30));
    }

    #[test]
    fn smoothing_never_changes_the_total_distance() {
        let mut pf = perf();
        pf.smoothing = 0.6;
        let mut p = Processor::new(&pf, NATIVE);
        let moves = [(5, 0), (9, 0), (2, 0), (7, 0), (1, 0), (12, 0), (3, 0)];
        let mut got = run(&mut p, &moves).0;
        // A pause releases whatever is still held back.
        got += p.process(0, 0, 80.0).0;
        let expected: i32 = moves.iter().map(|m| m.0).sum();
        assert_eq!(got, expected);
    }

    #[test]
    fn needs_movement_is_off_by_default() {
        assert!(!perf().needs_movement(NATIVE));
        let mut pf = perf();
        pf.stages.push(Stage { dpi: 1600, dpi_y: None });
        assert!(!pf.needs_movement(6));
    }
}
