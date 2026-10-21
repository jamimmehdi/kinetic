//! An optional activity log: what Kinetic did, and whether the system accepted it. It exists to
//! answer "did my remaps and movement changes actually work in this game?". It records button
//! presses (which button, which kind of action), movement and scroll summaries, whether injected
//! input was accepted, foreground app changes and when the engine steps aside. It never records
//! key names or typed text.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::config::Action;
use crate::{bus, foreground};

static ENABLED: AtomicBool = AtomicBool::new(false);
static MOVE_SENT: AtomicU32 = AtomicU32::new(0);
static MOVE_SEEN: AtomicU32 = AtomicU32::new(0);
static SEND_OK: AtomicU32 = AtomicU32::new(0);
static SEND_FAILED: AtomicU32 = AtomicU32::new(0);
static WHEEL: AtomicU32 = AtomicU32::new(0);
static LAST_FLUSH: Mutex<Option<Instant>> = Mutex::new(None);
static RECENT: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());

const KEEP_IN_MEMORY: usize = 300;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(on: bool) {
    if ENABLED.swap(on, Ordering::Relaxed) != on && on {
        record("log", json!({ "state": "started" }));
    }
}

/// Where the log file lives, for the interface's "show in folder".
pub fn path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Kinetic").join("activity.log"))
}

/// What kind of action a mapping runs, without revealing which keys.
pub fn action_kind(a: &Action) -> &'static str {
    match a {
        Action::Key { .. } => "key",
        Action::Mouse { .. } => "mouse",
        Action::Macro { .. } => "macro",
        Action::Dpi { .. } => "dpi",
        Action::Shift => "shift",
        Action::Launch { .. } => "launch",
        Action::Disabled => "disabled",
    }
}

pub fn record(kind: &str, detail: Value) {
    if !enabled() {
        return;
    }
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let entry = json!({ "t": ms, "app": foreground::last_app(), "kind": kind, "detail": detail });
    if let Ok(mut r) = RECENT.lock() {
        if r.len() >= KEEP_IN_MEMORY {
            r.pop_front();
        }
        r.push_back(entry.clone());
    }
    append_to_file(&entry);
    bus::publish(&json!({ "t": "activity", "entry": entry }));
}

fn append_to_file(entry: &Value) {
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_file_name("activity.old.log"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{entry}");
    }
}

pub fn history() -> Value {
    let entries: Vec<Value> = RECENT.lock().map(|r| r.iter().cloned().collect()).unwrap_or_default();
    json!({ "t": "activity_history", "entries": entries, "enabled": enabled() })
}

pub fn clear() {
    if let Ok(mut r) = RECENT.lock() {
        r.clear();
    }
    if let Some(p) = path() {
        let _ = std::fs::remove_file(p);
    }
    bus::publish(&history());
}

// ---- counters fed from the hot paths (cheap atomics) ----------------------------------------------

pub fn move_sent() {
    if enabled() {
        MOVE_SENT.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn move_seen() {
    if enabled() {
        MOVE_SEEN.fetch_add(1, Ordering::Relaxed);
    }
}

/// The result of one `SendInput` call: how many of `wanted` the system accepted.
pub fn input_sent(wanted: u32, accepted: u32) {
    if enabled() {
        SEND_OK.fetch_add(accepted, Ordering::Relaxed);
        SEND_FAILED.fetch_add(wanted.saturating_sub(accepted), Ordering::Relaxed);
    }
}

pub fn wheel_handled() {
    if enabled() {
        WHEEL.fetch_add(1, Ordering::Relaxed);
    }
}

/// Called often from the telemetry thread. About once a second it turns the counters into entries.
pub fn tick() {
    if !enabled() {
        return;
    }
    {
        let Ok(mut last) = LAST_FLUSH.lock() else { return };
        match *last {
            Some(t) if t.elapsed().as_millis() < 1000 => return,
            _ => *last = Some(Instant::now()),
        }
    }
    let (sent, seen) = (MOVE_SENT.swap(0, Ordering::Relaxed), MOVE_SEEN.swap(0, Ordering::Relaxed));
    let (ok, failed) = (SEND_OK.swap(0, Ordering::Relaxed), SEND_FAILED.swap(0, Ordering::Relaxed));
    let wheel = WHEEL.swap(0, Ordering::Relaxed);
    if sent > 0 {
        record("movement", json!({ "sent": sent, "delivered": seen, "worked": verdict(sent, seen) }));
    }
    if ok + failed > 0 {
        record("injected_input", json!({ "accepted": ok, "refused": failed, "worked": failed == 0 }));
    }
    if wheel > 0 {
        record("scroll", json!({ "notches": wheel }));
    }
}

/// Movement we sent counts as working when nearly all of it came back through the hook.
pub fn verdict(sent: u32, seen: u32) -> bool {
    seen as f32 >= sent as f32 * 0.9
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn movement_verdict() {
        assert!(verdict(100, 100));
        assert!(verdict(100, 95));
        assert!(!verdict(100, 0));
        assert!(!verdict(100, 50));
    }

    #[test]
    fn action_kinds_hide_the_keys() {
        assert_eq!(action_kind(&Action::Key { keys: vec!["ctrl".into(), "c".into()] }), "key");
        assert_eq!(action_kind(&Action::Shift), "shift");
    }
}
