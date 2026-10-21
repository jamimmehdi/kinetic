//! A hold-still test for a shaky hand. The user rests their hand on the mouse and tries to keep it
//! still for a few seconds; the tiny movements the sensor reports are tremor. From them we work out
//! how big the shaking is, how fast it is, and suggest steady-hand settings. Only mouse movement is
//! recorded, nothing else, and nothing leaves the engine except the result.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::bus;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Events kept at most, so a runaway session cannot grow without bound (about 8 kHz for 12 s).
const MAX_EVENTS: usize = 120_000;
const MAX_SECONDS: u64 = 15;

struct Session {
    started: Instant,
    /// (microseconds since the start, dx, dy)
    events: Vec<(u64, i32, i32)>,
    generation: u32,
    dpi: u32,
}

static GENERATION: Mutex<u32> = Mutex::new(0);

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Called for every movement of a physical mouse.
pub fn feed(dx: i32, dy: i32) {
    if !active() || (dx == 0 && dy == 0) {
        return;
    }
    let Ok(mut guard) = SESSION.try_lock() else { return };
    if let Some(s) = guard.as_mut() {
        if s.events.len() < MAX_EVENTS {
            s.events.push((s.started.elapsed().as_micros() as u64, dx, dy));
        }
    }
}

/// Begin a session of `seconds` for a mouse running at `dpi` counts per inch.
pub fn start(seconds: u64, dpi: u32) {
    let seconds = seconds.clamp(3, MAX_SECONDS);
    let generation = {
        let Ok(mut g) = GENERATION.lock() else { return };
        *g += 1;
        *g
    };
    if let Ok(mut s) = SESSION.lock() {
        *s = Some(Session { started: Instant::now(), events: Vec::new(), generation, dpi: dpi.max(50) });
    }
    ACTIVE.store(true, Ordering::Relaxed);
    publish_progress(0, 0, seconds);
    std::thread::spawn(move || {
        let began = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let ms = began.elapsed().as_millis() as u64;
            let (current, events) = match SESSION.lock() {
                Ok(g) => match g.as_ref() {
                    Some(s) => (s.generation, s.events.len()),
                    None => return,
                },
                Err(_) => return,
            };
            if current != generation {
                return;
            }
            if ms >= seconds * 1000 {
                finish(generation);
                return;
            }
            publish_progress(ms, events, seconds);
        }
    });
}

pub fn cancel() {
    ACTIVE.store(false, Ordering::Relaxed);
    if let Ok(mut s) = SESSION.lock() {
        *s = None;
    }
    bus::publish(&json!({ "t": "tremor", "state": "idle" }));
}

fn publish_progress(ms: u64, events: usize, seconds: u64) {
    bus::publish(&json!({ "t": "tremor", "state": "running", "elapsed_ms": ms, "seconds": seconds, "events": events }));
}

fn finish(generation: u32) {
    ACTIVE.store(false, Ordering::Relaxed);
    let Some(session) = SESSION.lock().ok().and_then(|mut s| s.take()) else { return };
    if session.generation != generation {
        return;
    }
    let duration_ms = session.started.elapsed().as_millis() as u64;
    let a = analyze(&session.events, duration_ms.max(1), session.dpi);
    bus::publish(&json!({
        "t": "tremor", "state": "done",
        "events": a.events, "rms_counts": round2(a.rms_counts), "rms_mm": round3(a.rms_mm),
        "dominant_hz": round2(a.dominant_hz), "prominence": round2(a.prominence),
        "peak_speed": round3(a.peak_speed), "level": a.level, "dpi": session.dpi,
        "suggestion": suggestion(&a),
    }));
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    pub events: usize,
    /// Size of the shaking: root mean square distance from where the hand drifts to, in counts.
    pub rms_counts: f64,
    pub rms_mm: f64,
    /// The strongest rhythm in the shaking, in hertz, between 1 and 25.
    pub dominant_hz: f64,
    /// How much stronger that rhythm is than the rest. High means a regular tremor.
    pub prominence: f64,
    /// Fast end of the shaking speed (95th percentile), in counts per millisecond.
    pub peak_speed: f64,
    pub level: &'static str,
}

/// Window over which the slow drift of the resting hand is removed, in milliseconds.
const DRIFT_WINDOW_MS: usize = 400;
/// Window over which the shaking's speed is measured, in milliseconds.
const SPEED_WINDOW_MS: usize = 8;

/// Works out the size and rhythm of the shaking in `events` over `duration_ms`.
pub fn analyze(events: &[(u64, i32, i32)], duration_ms: u64, dpi: u32) -> Analysis {
    let n = duration_ms.clamp(1, MAX_SECONDS * 1000) as usize;
    // Position at 1 ms steps: the running total of the counts that arrived.
    let mut step_x = vec![0.0f64; n];
    let mut step_y = vec![0.0f64; n];
    for &(us, dx, dy) in events {
        let i = ((us / 1000) as usize).min(n - 1);
        step_x[i] += dx as f64;
        step_y[i] += dy as f64;
    }
    let (mut px, mut py) = (Vec::with_capacity(n), Vec::with_capacity(n));
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..n {
        cx += step_x[i];
        cy += step_y[i];
        px.push(cx);
        py.push(cy);
    }
    let rx = detrend(&px);
    let ry = detrend(&py);

    // The first and last stretch have a lopsided drift estimate, so leave them out of the numbers.
    let edge = (DRIFT_WINDOW_MS / 2).min(n / 4);
    let (rx, ry) = (&rx[edge..n - edge], &ry[edge..n - edge]);
    let m = rx.len().max(1);

    let rms_counts = (rx.iter().zip(ry).map(|(a, b)| a * a + b * b).sum::<f64>() / m as f64).sqrt();
    let rms_mm = rms_counts / dpi.max(1) as f64 * 25.4;

    // Speed of the shaking in counts per millisecond, over a short window so that whole-count
    // steps do not make slow shaking look like it stands still.
    let mut speeds: Vec<f64> = (SPEED_WINDOW_MS..rx.len())
        .map(|i| {
            let j = i - SPEED_WINDOW_MS;
            ((rx[i] - rx[j]).powi(2) + (ry[i] - ry[j]).powi(2)).sqrt() / SPEED_WINDOW_MS as f64
        })
        .collect();
    speeds.sort_by(|a, b| a.total_cmp(b));
    let peak_speed = speeds.get((speeds.len() as f64 * 0.95) as usize).copied().unwrap_or(0.0);

    let (dominant_hz, prominence) = dominant_rhythm(rx, ry);
    let level = level_of(events.len(), rms_mm);
    Analysis { events: events.len(), rms_counts, rms_mm, dominant_hz, prominence, peak_speed, level }
}

/// Position minus its own moving average, which removes slow drift and keeps the quick shaking.
fn detrend(p: &[f64]) -> Vec<f64> {
    let n = p.len();
    let half = DRIFT_WINDOW_MS / 2;
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + p[i];
    }
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(n);
            p[i] - (prefix[hi] - prefix[lo]) / (hi - lo) as f64
        })
        .collect()
}

/// Strongest rhythm between 1 and 25 Hz in the two detrended signals, and how much it stands out.
fn dominant_rhythm(x: &[f64], y: &[f64]) -> (f64, f64) {
    let n = x.len();
    if n < 1000 {
        return (0.0, 0.0);
    }
    let mut powers: Vec<(f64, f64)> = Vec::new();
    let mut f = 1.0;
    while f <= 25.0 {
        let w = 2.0 * std::f64::consts::PI * f / 1000.0;
        let mut power = 0.0;
        for sig in [x, y] {
            let (mut re, mut im) = (0.0, 0.0);
            for (i, v) in sig.iter().enumerate() {
                let (s, c) = (w * i as f64).sin_cos();
                re += v * c;
                im += v * s;
            }
            power += re * re + im * im;
        }
        powers.push((f, power));
        f += 0.25;
    }
    let mean = powers.iter().map(|p| p.1).sum::<f64>() / powers.len() as f64;
    let best = powers.iter().copied().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap_or((0.0, 0.0));
    if best.1 <= 0.0 {
        return (0.0, 0.0);
    }
    let prominence = if mean > 0.0 { best.1 / mean } else { 0.0 };
    (best.0, prominence)
}

/// How much shaking there is, from the size of it (in millimetres at the sensor).
fn level_of(events: usize, rms_mm: f64) -> &'static str {
    if events < 20 || rms_mm < 0.02 {
        "none"
    } else if rms_mm < 0.08 {
        "light"
    } else if rms_mm < 0.25 {
        "medium"
    } else {
        "strong"
    }
}

/// The steady-hand settings that fit an analysis. Only a precision zone and speed smoothing are
/// suggested: smoothing the pointer itself would add delay, which hurts more than it helps.
pub fn suggestion(a: &Analysis) -> Value {
    let (factor, smoothing) = match a.level {
        "light" => (0.8, 0.6),
        "medium" => (0.6, 0.75),
        "strong" => (0.45, 0.85),
        _ => return json!({ "precision": false }),
    };
    // Cover the shaking's own speed with a little room, so deliberate movement is left alone.
    let below = (a.peak_speed * 1.5).clamp(0.3, 6.0);
    json!({
        "precision": true,
        "precision_below": round2(below),
        "precision_factor": factor,
        "speed_smoothing": smoothing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A resting hand: `amp` counts of shaking at `hz`, plus a slow drift, as 1 ms events.
    fn shaking(amp: f64, hz: f64, seconds: usize, drift_per_s: f64) -> Vec<(u64, i32, i32)> {
        let n = seconds * 1000;
        let pos = |i: usize| {
            let t = i as f64 / 1000.0;
            (amp * (2.0 * std::f64::consts::PI * hz * t).sin() + drift_per_s * t, amp * 0.5 * (2.0 * std::f64::consts::PI * hz * t + 1.0).sin())
        };
        let mut out = Vec::new();
        let (mut ox, mut oy) = (0i64, 0i64);
        for i in 1..n {
            let (x, y) = pos(i);
            let (tx, ty) = (x.round() as i64, y.round() as i64);
            let (dx, dy) = ((tx - ox) as i32, (ty - oy) as i32);
            ox = tx;
            oy = ty;
            if dx != 0 || dy != 0 {
                out.push((i as u64 * 1000, dx, dy));
            }
        }
        out
    }

    #[test]
    fn finds_the_rhythm_of_a_tremor() {
        let a = analyze(&shaking(8.0, 8.0, 8, 0.0), 8000, 800);
        assert!((a.dominant_hz - 8.0).abs() <= 0.5, "found {} Hz", a.dominant_hz);
        assert!(a.prominence > 5.0, "should stand out clearly, got {}", a.prominence);
    }

    #[test]
    fn size_and_speed_follow_the_amplitude() {
        let small = analyze(&shaking(3.0, 8.0, 8, 0.0), 8000, 800);
        let big = analyze(&shaking(15.0, 8.0, 8, 0.0), 8000, 800);
        assert!(big.rms_counts > small.rms_counts * 3.0);
        assert!(big.peak_speed > small.peak_speed * 3.0);
        // 15 counts at 800 DPI is about 0.5 mm of swing.
        assert!(big.rms_mm > 0.2 && big.rms_mm < 0.5, "rms {} mm", big.rms_mm);
    }

    #[test]
    fn slow_drift_is_not_counted_as_shaking() {
        let still = analyze(&shaking(0.0, 8.0, 8, 60.0), 8000, 800);
        assert_eq!(still.level, "none", "a slowly drifting hand is not a tremor, rms {} mm", still.rms_mm);
    }

    #[test]
    fn no_movement_means_no_tremor() {
        let a = analyze(&[], 8000, 800);
        assert_eq!(a.level, "none");
        assert_eq!(suggestion(&a), json!({ "precision": false }));
    }

    #[test]
    fn levels_are_ordered_by_size() {
        assert_eq!(level_of(500, 0.01), "none");
        assert_eq!(level_of(500, 0.05), "light");
        assert_eq!(level_of(500, 0.15), "medium");
        assert_eq!(level_of(500, 0.5), "strong");
        assert_eq!(level_of(3, 0.5), "none", "too few events to say");
    }

    #[test]
    fn stronger_shaking_gets_a_stronger_suggestion() {
        let light = suggestion(&Analysis { events: 500, rms_counts: 1.0, rms_mm: 0.05, dominant_hz: 8.0, prominence: 9.0, peak_speed: 0.4, level: "light" });
        let strong = suggestion(&Analysis { events: 500, rms_counts: 9.0, rms_mm: 0.4, dominant_hz: 8.0, prominence: 9.0, peak_speed: 1.2, level: "strong" });
        assert!(strong["precision_factor"].as_f64().unwrap() < light["precision_factor"].as_f64().unwrap());
        assert!(strong["precision_below"].as_f64().unwrap() > light["precision_below"].as_f64().unwrap());
        assert!(strong["speed_smoothing"].as_f64().unwrap() > light["speed_smoothing"].as_f64().unwrap());
    }
}
