//! "Press a button to detect": watches HID reports and works out which signal is a button, so a
//! button the app does not know can be added without any new code.
//!
//! Two modes. Single: listen a few seconds and pick the one signal that alternates between two
//! values. Multi (the first-launch guide): keep listening and offer every new button as soon as it
//! is seen pressed and released, one after another.
//!
//! A button looks like a report that goes from a value to zero when released. Noise, such as a
//! sensor or battery counter, takes many values and is ignored.

use crate::config::{self, LearnedButton};
use crate::{bus, models};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::Duration;

const WINDOW: Duration = Duration::from_secs(6);
/// A guide session ends by itself after this long, in case the window was closed mid-way.
const MULTI_LIMIT: Duration = Duration::from_secs(180);
const MAX_REPORTS_PER_PATH: usize = 64;

struct State {
    listening: bool,
    multi: bool,
    /// Every report seen per HID path, in order.
    seen: HashMap<String, Vec<Vec<u8>>>,
    /// Single mode: the detected button waiting for a name.
    pending: Option<LearnedButton>,
    /// Multi mode: every new button found so far, waiting for a name.
    candidates: Vec<LearnedButton>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State { listening: false, multi: false, seen: HashMap::new(), pending: None, candidates: Vec::new() })
});
static SESSION: AtomicU64 = AtomicU64::new(0);

pub fn listening() -> bool {
    STATE.lock().map(|s| s.listening).unwrap_or(false)
}

pub fn start(multi: bool) {
    let session = {
        let Ok(mut s) = STATE.lock() else { return };
        if s.listening {
            return;
        }
        s.listening = true;
        s.multi = multi;
        s.seen.clear();
        s.pending = None;
        s.candidates.clear();
        SESSION.fetch_add(1, Ordering::Relaxed) + 1
    };
    crate::input::set_learn_pages(true);
    let seconds = if multi { MULTI_LIMIT.as_secs() } else { WINDOW.as_secs() };
    bus::publish(&json!({ "t": "learn", "state": "listening", "seconds": seconds, "multi": multi }));
    thread::spawn(move || {
        thread::sleep(if multi { MULTI_LIMIT } else { WINDOW });
        if SESSION.load(Ordering::Relaxed) == session {
            if multi {
                cancel();
            } else {
                finish();
            }
        }
    });
}

pub fn cancel() {
    if let Ok(mut s) = STATE.lock() {
        s.listening = false;
        s.seen.clear();
        s.pending = None;
        s.candidates.clear();
    }
    crate::input::set_learn_pages(false);
    bus::publish(&json!({ "t": "learn", "state": "idle" }));
}

/// Called for every HID report while listening.
pub fn observe(path: &str, report: &[u8]) {
    let Ok(mut s) = STATE.lock() else { return };
    if !s.listening || models::vid_pid(path).is_none() {
        return;
    }
    let list = s.seen.entry(path.to_string()).or_default();
    if list.len() < MAX_REPORTS_PER_PATH {
        list.push(report.to_vec());
    }
    if !s.multi {
        return;
    }

    // Multi mode: this path may just have shown a complete press and release.
    let reports = s.seen.get(path).cloned().unwrap_or_default();
    let Some(button) = clean_release_pair(path, &reports) else { return };
    let learned = config::current().learned;
    if models::is_known(&button, &learned) || s.candidates.iter().any(|c| same_signal(c, &button)) {
        return;
    }
    let taken: Vec<LearnedButton> = learned.iter().chain(s.candidates.iter()).cloned().collect();
    let mut button = button;
    button.button = models::next_button(button.vid, button.pid, &taken);
    s.candidates.push(button);
    publish_candidates(&s);
}

fn same_signal(a: &LearnedButton, b: &LearnedButton) -> bool {
    (a.vid, a.pid, &a.path_contains, a.report_id, a.byte_index, a.down_value)
        == (b.vid, b.pid, &b.path_contains, b.report_id, b.byte_index, b.down_value)
}

fn publish_candidates(s: &State) {
    let items: Vec<_> = s.candidates.iter().map(|c| json!({ "button": c.button, "vid": c.vid, "pid": c.pid })).collect();
    bus::publish(&json!({ "t": "learn", "state": "candidates", "items": items }));
}

/// A press followed by a release: the first report has one byte set that the second has at zero,
/// and nothing else differs. Strict on purpose, so a counter never passes for a button.
fn clean_release_pair(path: &str, reports: &[Vec<u8>]) -> Option<LearnedButton> {
    let mut distinct: Vec<&Vec<u8>> = Vec::new();
    for r in reports {
        if !distinct.contains(&r) {
            distinct.push(r);
        }
        if distinct.len() > 2 {
            return None;
        }
    }
    if distinct.len() != 2 || reports.first()? != distinct[0] {
        return None;
    }
    let (down, up) = (distinct[0], distinct[1]);
    if down.len() != up.len() || down.len() < 2 || down[0] != up[0] {
        return None;
    }
    let differing: Vec<usize> = (1..down.len()).filter(|&i| down[i] != up[i]).collect();
    let [idx] = differing[..] else { return None };
    if up[idx] != 0 || down[idx] == 0 {
        return None;
    }
    let (vid, pid) = models::vid_pid(path)?;
    Some(LearnedButton {
        vid,
        pid,
        path_contains: models::collection_tag(path),
        report_id: down[0],
        byte_index: idx,
        down_value: down[idx],
        up_value: 0,
        button: 0,
        label: String::new(),
    })
}

/// Picks the path whose reports alternate between exactly two values (single mode).
fn detect(seen: &HashMap<String, Vec<Vec<u8>>>, learned: &[LearnedButton]) -> Option<LearnedButton> {
    let mut candidates = Vec::new();
    for (path, reports) in seen {
        let mut distinct: Vec<&Vec<u8>> = Vec::new();
        for r in reports {
            if !distinct.contains(&r) {
                distinct.push(r);
            }
            if distinct.len() > 2 {
                break;
            }
        }
        if distinct.len() != 2 || reports.len() < 2 {
            continue;
        }
        // The first report seen is the press, the other the release.
        let (down, up) = (distinct[0], distinct[1]);
        if down.len() != up.len() || down.is_empty() || down[0] != up[0] {
            continue;
        }
        let Some(idx) = (1..down.len()).find(|&i| down[i] != up[i]) else { continue };
        let (vid, pid) = models::vid_pid(path)?;
        candidates.push(LearnedButton {
            vid,
            pid,
            path_contains: models::collection_tag(path),
            report_id: down[0],
            byte_index: idx,
            down_value: down[idx],
            up_value: up[idx],
            button: models::next_button(vid, pid, learned),
            label: String::new(),
        });
    }
    // Exactly one clear candidate, otherwise it is ambiguous and nothing is guessed.
    if candidates.len() == 1 {
        candidates.pop()
    } else {
        None
    }
}

fn finish() {
    let (found, noisy) = {
        let Ok(mut s) = STATE.lock() else { return };
        if !s.listening {
            return;
        }
        s.listening = false;
        let learned = config::current().learned;
        let found = detect(&s.seen, &learned);
        let noisy = !s.seen.is_empty();
        s.pending = found.clone();
        s.seen.clear();
        (found, noisy)
    };
    crate::input::set_learn_pages(false);
    match found {
        Some(f) => bus::publish(&json!({ "t": "learn", "state": "found", "button": f.button, "vid": f.vid, "pid": f.pid })),
        None => bus::publish(&json!({ "t": "learn", "state": "none", "saw_reports": noisy })),
    }
}

/// The user named a detected button: save it to the config. In multi mode `button` says which one.
pub fn confirm(label: &str, button: Option<u8>) -> bool {
    let found = {
        let Ok(mut s) = STATE.lock() else { return false };
        match button {
            Some(b) => s.candidates.iter().position(|c| c.button == b).map(|i| s.candidates.remove(i)),
            None => s.pending.take(),
        }
    };
    let Some(mut found) = found else { return false };
    found.label = if label.trim().is_empty() { format!("Button {}", found.button) } else { label.trim().to_string() };
    let mut cfg = config::current();
    cfg.learned.push(found);
    let applied = config::replace(cfg);
    bus::publish(&json!({ "t": "config", "config": applied }));
    bus::publish(&crate::input::devices_event());
    if let Ok(s) = STATE.lock() {
        if s.multi {
            publish_candidates(&s);
            return true;
        }
    }
    bus::publish(&json!({ "t": "learn", "state": "idle" }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = r"\\?\HID#VID_1532&PID_0094&MI_01&Col05#8&1a2b";
    const OTHER: &str = r"\\?\HID#VID_046D&PID_C52B&MI_01&Col02#x";

    fn seen(path: &str, reports: &[&[u8]]) -> HashMap<String, Vec<Vec<u8>>> {
        HashMap::from([(path.to_string(), reports.iter().map(|r| r.to_vec()).collect())])
    }

    fn vecs(reports: &[&[u8]]) -> Vec<Vec<u8>> {
        reports.iter().map(|r| r.to_vec()).collect()
    }

    #[test]
    fn finds_a_press_release_pair() {
        let s = seen(PATH, &[&[4, 0x52, 0, 0], &[4, 0, 0, 0], &[4, 0x52, 0, 0], &[4, 0, 0, 0]]);
        let l = detect(&s, &[]).expect("button found");
        assert_eq!((l.vid, l.pid, l.report_id, l.byte_index), (0x1532, 0x0094, 4, 1));
        assert_eq!((l.down_value, l.up_value), (0x52, 0));
        assert_eq!(l.path_contains, "COL05");
        // This Razer model already has button 6 built in, so the new one is 7.
        assert_eq!(l.button, 7);
    }

    #[test]
    fn ignores_noise_with_many_values() {
        let s = seen(PATH, &[&[5, 0x31, 0xa6], &[5, 0x31, 0xa9], &[5, 0x31, 0xa4], &[5, 0x31, 0xa0]]);
        assert!(detect(&s, &[]).is_none());
    }

    #[test]
    fn needs_a_repeat_and_a_single_candidate() {
        assert!(detect(&seen(PATH, &[&[4, 0x52]]), &[]).is_none(), "one report is not enough");
        let mut both = seen(PATH, &[&[4, 0x52], &[4, 0]]);
        both.insert(r"\\?\HID#VID_1532&PID_0094&MI_01&Col06#x".into(), vec![vec![9, 1], vec![9, 0]]);
        assert!(detect(&both, &[]).is_none(), "two candidates are ambiguous");
    }

    #[test]
    fn guide_accepts_one_press_and_release() {
        // One press is enough: a value that goes back to zero.
        let b = clean_release_pair(OTHER, &vecs(&[&[0x10, 0, 0x80, 0], &[0x10, 0, 0, 0]])).expect("a button");
        assert_eq!((b.report_id, b.byte_index, b.down_value, b.up_value), (0x10, 2, 0x80, 0));
        assert_eq!(b.path_contains, "COL02");
    }

    #[test]
    fn guide_rejects_counters_and_odd_pairs() {
        // A counter changing between two non-zero values is not a button.
        assert!(clean_release_pair(OTHER, &vecs(&[&[5, 0x31, 0xa6], &[5, 0x31, 0xa9]])).is_none());
        // Starting from zero means the press was missed.
        assert!(clean_release_pair(OTHER, &vecs(&[&[4, 0, 0], &[4, 0x52, 0]])).is_none());
        // Two bytes changing at once is not a simple button.
        assert!(clean_release_pair(OTHER, &vecs(&[&[4, 1, 2], &[4, 0, 0]])).is_none());
        // Many values: noise.
        assert!(clean_release_pair(OTHER, &vecs(&[&[4, 1], &[4, 0], &[4, 2]])).is_none());
        // Only one value seen so far.
        assert!(clean_release_pair(OTHER, &vecs(&[&[4, 1]])).is_none());
    }

    #[test]
    fn guide_repeat_presses_still_count_once() {
        let r = vecs(&[&[4, 0x52], &[4, 0], &[4, 0x52], &[4, 0]]);
        assert!(clean_release_pair(OTHER, &r).is_some());
    }
}
