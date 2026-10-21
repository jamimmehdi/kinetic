//! Kernel mode: movement processing done by the Raw Accel driver instead of by this engine.
//!
//! The engine's own movement processing swallows the real mouse movement and sends it again with
//! `SendInput`. Anti-cheat drivers (Riot Vanguard) refuse that. Raw Accel is a signed Windows
//! filter driver that changes the movement inside the mouse's own driver stack, so there is no
//! injection for anyone to refuse. This module turns Kinetic's settings into a Raw Accel settings
//! file and hands it to Raw Accel's own `writer.exe`, which talks to the driver.
//!
//! Raw Accel is MIT licensed: https://github.com/RawAccelOfficial/rawaccel

use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::accel::{Curve, V_MAX};
use crate::config::Perf;
use crate::{bus, hook};

/// The Raw Accel release this was written against. The settings file carries it as its version.
const RAW_ACCEL_VERSION: &str = "1.7.1";
/// The driver waits this long after a write before it takes the next one.
const WRITE_GAP: Duration = Duration::from_millis(1300);
/// Longest a writer run may take. It shows a message box on errors, which would otherwise wait forever.
const WRITER_TIMEOUT: Duration = Duration::from_secs(15);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Points in the lookup table that carries Kinetic's curve (the driver takes up to 257).
const LUT_POINTS: usize = 129;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Kernel mode is on and the driver and writer are both there, so the engine leaves movement to it.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static TX: OnceLock<Sender<String>> = OnceLock::new();
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
static APPLIED: Mutex<Option<String>> = Mutex::new(None);

/// Where the app puts the Raw Accel files it downloads.
pub fn folder() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Kinetic").join("rawaccel"))
}

fn writer_path() -> Option<PathBuf> {
    let p = folder()?.join("writer.exe");
    p.is_file().then_some(p)
}

/// True when the Raw Accel driver is loaded, found by opening its control device.
pub fn driver_installed() -> bool {
    if hook::test_mode() {
        return false;
    }
    std::fs::OpenOptions::new().access_mode(0).share_mode(0).open(r"\\.\rawaccel").is_ok()
}

/// Kernel mode is on and working: the engine must not process movement itself.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn start() {
    if hook::test_mode() || TX.get().is_some() {
        return;
    }
    let (tx, rx) = channel::<String>();
    let _ = TX.set(tx);
    std::thread::spawn(move || {
        let mut last_write: Option<Instant> = None;
        while let Ok(mut json) = rx.recv() {
            // Keep only the newest request, and give the driver its pause between writes.
            std::thread::sleep(Duration::from_millis(250));
            while let Ok(newer) = rx.try_recv() {
                json = newer;
            }
            if let Some(t) = last_write {
                let wait = WRITE_GAP.saturating_sub(t.elapsed());
                std::thread::sleep(wait);
            }
            if APPLIED.lock().ok().and_then(|a| a.clone()).as_deref() == Some(json.as_str()) {
                continue;
            }
            let result = write_settings(&json);
            last_write = Some(Instant::now());
            match result {
                Ok(()) => {
                    set_error(None);
                    if let Ok(mut a) = APPLIED.lock() {
                        *a = Some(json);
                    }
                }
                Err(e) => set_error(Some(e)),
            }
            publish_status();
        }
    });
    refresh();
}

fn set_error(e: Option<String>) {
    if let Ok(mut l) = LAST_ERROR.lock() {
        *l = e;
    }
}

/// Re-reads whether the driver and writer are there, and updates what the engine does about it.
pub fn refresh() {
    let on = enabled() && driver_installed() && writer_path().is_some();
    let was = ACTIVE.swap(on, Ordering::Relaxed);
    publish_status();
    if was != on {
        crate::movement::apply_config();
    }
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    if !on {
        // Back to plain movement. The driver keeps whatever it was last given, so give it a neutral setting.
        if ACTIVE.load(Ordering::Relaxed) {
            queue(neutral_settings().to_string());
        }
        if let Ok(mut a) = APPLIED.lock() {
            *a = None;
        }
    }
    refresh();
    crate::movement::apply_config();
}

/// Called whenever the movement settings, DPI stage or profile change.
pub fn sync(perf: &Perf, target: (u32, u32), native: u32, paused: bool) {
    if !active() {
        return;
    }
    let settings = if paused || !perf.needs_movement_for(target, native) {
        neutral_settings()
    } else {
        build_settings(perf, target, native)
    };
    queue(settings.to_string());
}

fn queue(json: String) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(json);
    }
}

/// On quit: leave the driver neutral so acceleration does not outlive Kinetic.
pub fn restore_blocking() {
    if !active() {
        return;
    }
    let _ = write_settings(&neutral_settings().to_string());
}

fn write_settings(json: &str) -> Result<(), String> {
    let dir = folder().ok_or("no data folder")?;
    let writer = writer_path().ok_or("Raw Accel's writer.exe is not installed")?;
    let file = dir.join("kinetic-settings.json");
    std::fs::write(&file, json).map_err(|e| format!("could not write the settings file: {e}"))?;
    let mut child = Command::new(writer)
        .arg(&file)
        .current_dir(&dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start writer.exe: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("writer.exe refused the settings (exit code {})", status.code().unwrap_or(-1))),
            Ok(None) if started.elapsed() > WRITER_TIMEOUT => {
                let _ = child.kill();
                return Err("writer.exe did not finish, so the driver is probably not installed or needs a restart".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("could not wait for writer.exe: {e}")),
        }
    }
}

pub fn status_event() -> Value {
    json!({
        "t": "kernel",
        "enabled": enabled(),
        "driver": driver_installed(),
        "writer": writer_path().is_some(),
        "active": active(),
        "error": LAST_ERROR.lock().ok().and_then(|e| e.clone()),
    })
}

pub fn publish_status() {
    bus::publish(&status_event());
}

// ---- turning Kinetic's settings into Raw Accel's ---------------------------------------------------

fn accel_args(mode: &str, lut: Vec<f32>) -> Value {
    json!({
        "mode": mode,
        "Gain / Velocity": false,
        "inputOffset": 0.0,
        "outputOffset": 0.0,
        "acceleration": 0.0,
        "decayRate": 0.1,
        "gamma": 1.0,
        "motivity": 1.5,
        "exponentClassic": 2.0,
        "scale": 1.0,
        "exponentPower": 0.05,
        "limit": 1.5,
        "syncSpeed": 5.0,
        "smooth": 0.5,
        "Cap / Jump": { "x": 15.0, "y": 1.5 },
        "Cap mode": "in_out",
        "data": lut,
    })
}

fn profile(accel: Value, combine: bool, output_dpi: f64, yx_ratio: f64, rotation: f64, snap: f64, halflife: f64) -> Value {
    json!({
        "name": "kinetic",
        "Stretches domain for horizontal vs vertical inputs": { "x": 1.0, "y": 1.0 },
        "Stretches accel range for horizontal vs vertical inputs": { "x": 1.0, "y": 1.0 },
        "Whole or horizontal accel parameters": accel.clone(),
        "Vertical accel parameters": accel,
        "Input speed calculation parameters": {
            "Whole/combined accel (set false for 'by component' mode)": combine,
            "lpNorm": 2.0,
            "Time in ms after which an input is weighted at half its original value.": 0.0,
            "Time in ms after which scale is weighted at half its original value.": 0.0,
            "Time in ms after which an output is weighted at half its original value.": halflife,
        },
        "Output DPI": output_dpi,
        "Y/X output DPI ratio (vertical sens multiplier)": yx_ratio,
        "L/R output DPI ratio (left sens multiplier)": 1.0,
        "U/D output DPI ratio (up sens multiplier)": 1.0,
        "Degrees of rotation": rotation,
        "Degrees of angle snapping": snap,
        "Input Speed Cap": 0.0,
    })
}

fn document(profile: Value) -> Value {
    json!({
        "version": RAW_ACCEL_VERSION,
        "defaultDeviceConfig": {
            "disable": false,
            "Use constant time interval based on polling rate": false,
            "DPI (normalizes input speed unit: counts/ms -> in/s)": 0,
            "Polling rate Hz (keep at 0 for automatic adjustment)": 0,
        },
        "profiles": [profile],
        "devices": [],
    })
}

/// A setting that changes nothing: no acceleration, no scaling.
pub fn neutral_settings() -> Value {
    document(profile(accel_args("noaccel", vec![]), true, 1000.0, 1.0, 0.0, 0.0, 0.0))
}

/// Kinetic's curve as a lookup table of (speed in counts per ms, sensitivity multiplier) points.
/// Sampling the finished curve keeps every mode, the gain form and the speed cap exactly as drawn.
fn lookup_table(perf: &Perf) -> Vec<f32> {
    let curve = Curve::build(&perf.accel);
    let mut data = Vec::with_capacity(LUT_POINTS * 2);
    for i in 0..LUT_POINTS {
        // The driver treats a speed of zero specially, so start just above it.
        let v = (V_MAX * i as f32 / (LUT_POINTS - 1) as f32).max(0.01);
        data.push(v);
        data.push(curve.multiplier(v));
    }
    data
}

/// Raw Accel settings that reproduce what the engine would do itself for this DPI target.
pub fn build_settings(perf: &Perf, target: (u32, u32), native: u32) -> Value {
    let native = native.max(1) as f64;
    // Output sensitivity multiplier = output DPI / 1000, so this scales the mouse's own DPI to the target.
    let output_dpi = 1000.0 * target.0 as f64 / native;
    let yx = (target.1 as f64 / target.0.max(1) as f64) * perf.y_ratio as f64;
    let accel = if perf.accel.mode == crate::config::AccelMode::Off {
        accel_args("noaccel", vec![])
    } else {
        accel_args("lut", lookup_table(perf))
    };
    // Smoothing here holds back a share of each move; the driver wants a half-life in milliseconds.
    // At the usual 1000 Hz one event is one millisecond.
    let s = perf.smoothing as f64;
    let halflife = if s > 0.001 { (0.5f64.ln() / s.ln()).max(0.0) } else { 0.0 };
    let snap = if perf.angle_snap { 6.0 } else { 0.0 };
    document(profile(
        accel,
        !perf.accel.per_axis,
        output_dpi,
        yx,
        perf.rotation as f64,
        snap,
        halflife,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AccelMode, Stage};

    fn perf() -> Perf {
        Perf::default()
    }

    fn prof(v: &Value) -> &Value {
        &v["profiles"][0]
    }

    #[test]
    fn neutral_changes_nothing() {
        let v = neutral_settings();
        assert_eq!(prof(&v)["Output DPI"], 1000.0);
        assert_eq!(prof(&v)["Whole or horizontal accel parameters"]["mode"], "noaccel");
        assert_eq!(prof(&v)["Degrees of rotation"], 0.0);
        assert_eq!(v["version"], RAW_ACCEL_VERSION);
    }

    #[test]
    fn target_dpi_becomes_the_output_multiplier() {
        let mut p = perf();
        p.stages = vec![Stage { dpi: 800, dpi_y: None }];
        let v = build_settings(&p, (800, 800), 1600);
        assert_eq!(prof(&v)["Output DPI"], 500.0);
        assert_eq!(prof(&v)["Y/X output DPI ratio (vertical sens multiplier)"], 1.0);
    }

    #[test]
    fn separate_y_dpi_and_y_ratio_combine() {
        let mut p = perf();
        p.y_ratio = 1.5;
        let v = build_settings(&p, (800, 400), 800);
        assert_eq!(prof(&v)["Y/X output DPI ratio (vertical sens multiplier)"], 0.75);
    }

    #[test]
    fn curves_travel_as_a_lookup_table() {
        let mut p = perf();
        p.accel.mode = AccelMode::Sigmoid;
        let v = build_settings(&p, (1600, 1600), 1600);
        let a = &prof(&v)["Whole or horizontal accel parameters"];
        assert_eq!(a["mode"], "lut");
        let data = a["data"].as_array().unwrap();
        assert_eq!(data.len(), LUT_POINTS * 2);
        assert!(data.len() <= 514, "the driver takes at most 257 points");
        // Speeds rise, and the multiplier at the top is the sigmoid's limit.
        let xs: Vec<f64> = data.iter().step_by(2).map(|x| x.as_f64().unwrap()).collect();
        assert!(xs.windows(2).all(|w| w[1] > w[0]));
        let top = data[data.len() - 1].as_f64().unwrap();
        assert!((top - p.accel.limit as f64).abs() < 0.05, "top {top}");
    }

    #[test]
    fn rotation_snap_and_smoothing_carry_over() {
        let mut p = perf();
        p.rotation = 12.0;
        p.angle_snap = true;
        p.smoothing = 0.5;
        let v = build_settings(&p, (1600, 1600), 1600);
        assert_eq!(prof(&v)["Degrees of rotation"], 12.0);
        assert_eq!(prof(&v)["Degrees of angle snapping"], 6.0);
        let half = prof(&v)["Input speed calculation parameters"]["Time in ms after which an output is weighted at half its original value."].as_f64().unwrap();
        assert!((half - 1.0).abs() < 1e-9, "half-life {half}");
    }

    #[test]
    fn per_axis_curves_use_by_component_mode() {
        let mut p = perf();
        p.accel.mode = AccelMode::Natural;
        p.accel.per_axis = true;
        let v = build_settings(&p, (1600, 1600), 1600);
        assert_eq!(prof(&v)["Input speed calculation parameters"]["Whole/combined accel (set false for 'by component' mode)"], false);
    }
}
