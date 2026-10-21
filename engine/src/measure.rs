//! Measures a mouse's real DPI. Windows never reports it, but if the user moves the mouse a known
//! distance the raw counts the sensor delivered give counts per inch directly.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::bus;

struct Session {
    cm: f64,
    /// Path length in counts, per device.
    counts: HashMap<String, f64>,
    last_publish: Instant,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Begin counting for a move of `cm` centimetres.
pub fn start(cm: f64) {
    let cm = cm.clamp(1.0, 100.0);
    if let Ok(mut s) = SESSION.lock() {
        *s = Some(Session { cm, counts: HashMap::new(), last_publish: Instant::now() });
    }
    bus::publish(&json!({ "t": "measure", "state": "running", "cm": cm, "counts": 0, "device": null }));
}

pub fn cancel() {
    if let Ok(mut s) = SESSION.lock() {
        *s = None;
    }
    bus::publish(&json!({ "t": "measure", "state": "idle" }));
}

/// Called for every raw movement of a physical device.
pub fn feed(device: &str, dx: i32, dy: i32) {
    let Ok(mut guard) = SESSION.lock() else { return };
    let Some(s) = guard.as_mut() else { return };
    *s.counts.entry(device.to_string()).or_insert(0.0) += ((dx as f64).powi(2) + (dy as f64).powi(2)).sqrt();
    if s.last_publish.elapsed() >= Duration::from_millis(100) {
        s.last_publish = Instant::now();
        let (device, counts) = busiest(&s.counts);
        bus::publish(&json!({ "t": "measure", "state": "running", "cm": s.cm, "counts": counts.round(), "device": device }));
    }
}

/// Finish: turn the counted path into counts per inch.
pub fn finish() {
    let Some(s) = SESSION.lock().ok().and_then(|mut g| g.take()) else { return };
    let (device, counts) = busiest(&s.counts);
    if device.is_none() || counts < 10.0 {
        bus::publish(&json!({ "t": "measure", "state": "failed", "reason": "no movement" }));
        return;
    }
    bus::publish(&json!({
        "t": "measure", "state": "done", "device": device, "cm": s.cm,
        "counts": counts.round(), "dpi": dpi_from(counts, s.cm),
    }));
}

/// Counts per inch for `counts` over `cm`, rounded to the 50s that mice actually use.
pub fn dpi_from(counts: f64, cm: f64) -> u32 {
    let raw = counts / (cm / 2.54);
    ((raw / 50.0).round() * 50.0).max(50.0) as u32
}

fn busiest(counts: &HashMap<String, f64>) -> (Option<String>, f64) {
    counts
        .iter()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(d, c)| (Some(d.clone()), *c))
        .unwrap_or((None, 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_cm_at_800_dpi() {
        // 800 counts per inch over 10 cm = 3149.6 counts.
        assert_eq!(dpi_from(3149.6, 10.0), 800);
    }

    #[test]
    fn rounds_to_fifty() {
        assert_eq!(dpi_from(1200.0, 2.54), 1200);
        assert_eq!(dpi_from(1230.0, 2.54), 1250);
    }

    #[test]
    fn finish_without_movement_is_a_failure_not_a_crash() {
        start(10.0);
        finish();
        assert!(SESSION.lock().unwrap().is_none());
    }
}
