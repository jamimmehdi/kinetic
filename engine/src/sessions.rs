//! Session tracking. The user picks apps (a game, say) to track. While one of them is running this
//! keeps a record of the session: when it started and ended, what Kinetic was doing every second
//! (working, paused, stepped aside, blocked...), how much mouse activity there was, and which
//! settings were in use. The dashboard turns that into a timeline and graphs.
//!
//! The record lives in the engine, which is the thing being tracked: if the engine stops during a
//! game, the gap is written down as "offline" the next time it starts.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::Tracked;
use crate::{bus, config, foreground, hook, kernel, movement, state};

/// Length of one activity bucket, in milliseconds.
pub const BUCKET_MS: u64 = 10_000;
const TICK: Duration = Duration::from_millis(1000);
/// How often (in ticks) the list of running apps is refreshed.
const DETECT_EVERY: u64 = 3;
const FLUSH_EVERY_MS: u64 = 20_000;
/// Most finished sessions kept on disk.
const MAX_FINISHED: usize = 60;
const MAX_SEGMENTS: usize = 4000;
const MAX_NOTES: usize = 200;
/// A pause between two ticks longer than this means nothing was watching (sleep, a stalled engine).
const GAP_MS: u64 = 5_000;

pub const WORKING: &str = "working";
pub const STANDBY: &str = "standby";
pub const PAUSED: &str = "paused";
pub const GAME_PAUSE: &str = "game_pause";
pub const BLOCKED: &str = "blocked";
pub const KERNEL_ERROR: &str = "kernel_error";
pub const OFFLINE: &str = "offline";

// ---- counters fed from the input paths (cheap atomics, always on) ----------------------------------

static MOVES: AtomicU32 = AtomicU32::new(0);
static SENT: AtomicU32 = AtomicU32::new(0);
static SEEN: AtomicU32 = AtomicU32::new(0);
static REFUSED: AtomicU32 = AtomicU32::new(0);
static BUTTONS: AtomicU32 = AtomicU32::new(0);

/// A real mouse movement arrived.
pub fn note_move() {
    MOVES.fetch_add(1, Ordering::Relaxed);
}
/// The engine sent a movement of its own.
pub fn note_sent() {
    SENT.fetch_add(1, Ordering::Relaxed);
}
/// One of the engine's own movements came back through the hook.
pub fn note_seen() {
    SEEN.fetch_add(1, Ordering::Relaxed);
}
/// Windows refused `n` events the engine tried to send.
pub fn note_refused(n: u32) {
    if n > 0 {
        REFUSED.fetch_add(n, Ordering::Relaxed);
    }
}
/// A remapped button ran its action.
pub fn note_button() {
    BUTTONS.fetch_add(1, Ordering::Relaxed);
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counters {
    pub moves: u32,
    pub sent: u32,
    pub seen: u32,
    pub refused: u32,
    pub buttons: u32,
}

impl Counters {
    fn take() -> Counters {
        Counters {
            moves: MOVES.swap(0, Ordering::Relaxed),
            sent: SENT.swap(0, Ordering::Relaxed),
            seen: SEEN.swap(0, Ordering::Relaxed),
            refused: REFUSED.swap(0, Ordering::Relaxed),
            buttons: BUTTONS.swap(0, Ordering::Relaxed),
        }
    }
}

// ---- the record ---------------------------------------------------------------------------------------

/// A stretch of time Kinetic spent in one state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub state: String,
    pub from: u64,
    pub to: u64,
}

/// Mouse activity over one `BUCKET_MS` window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bucket {
    pub t: u64,
    pub moves: u32,
    pub sent: u32,
    pub seen: u32,
    pub refused: u32,
    pub buttons: u32,
    /// The tracked app was the one in front at some point in this window.
    pub front: bool,
}

/// The settings in use from a moment on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub t: u64,
    pub settings: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub exe: String,
    pub name: String,
    pub started: u64,
    pub ended: Option<u64>,
    /// The last moment Kinetic saw the app running.
    pub last_seen: u64,
    pub ended_by: Option<String>,
    /// The app was already running when Kinetic started, so the real start is not known.
    pub late_start: bool,
    pub kernel_ms: u64,
    pub front_ms: u64,
    pub segments: Vec<Segment>,
    pub buckets: Vec<Bucket>,
    pub notes: Vec<Note>,
}

/// Everything the tracker needs to know about one moment.
pub struct Sample<'a> {
    pub now: u64,
    /// Executable names of the apps that are running now.
    pub running: &'a HashSet<String>,
    pub tracked: &'a [Tracked],
    pub state: &'a str,
    pub counters: Counters,
    /// Executable name of the app in front.
    pub front_exe: &'a str,
    pub kernel_active: bool,
    pub settings: Value,
}

#[derive(Debug, Default, PartialEq)]
pub struct Changes {
    pub started: Vec<String>,
    pub ended: Vec<String>,
}

#[derive(Default)]
pub struct Tracker {
    pub finished: Vec<Session>,
    pub active: HashMap<String, Session>,
    last_tick: u64,
}

impl Tracker {
    /// Adds what was found on disk at start: sessions that never got an end. One whose app is still
    /// running carries on, with the time Kinetic was not running written down as offline. One whose app
    /// has gone ends where Kinetic last saw it.
    pub fn recover(&mut self, open: Vec<Session>, now: u64, running: &HashSet<String>) {
        for mut s in open {
            if s.ended.is_some() {
                self.finished.push(s);
            } else if running.contains(&s.exe) && !self.active.contains_key(&s.exe) {
                if now > s.last_seen {
                    s.segments.push(Segment { state: OFFLINE.into(), from: s.last_seen, to: now });
                }
                s.last_seen = now;
                self.active.insert(s.exe.clone(), s);
            } else {
                s.ended = Some(s.last_seen);
                s.ended_by = Some("Kinetic was not running when it closed".into());
                self.finished.push(s);
            }
        }
        self.trim();
    }

    fn trim(&mut self) {
        self.finished.sort_by_key(|s| s.started);
        let extra = self.finished.len().saturating_sub(MAX_FINISHED);
        self.finished.drain(..extra);
    }

    /// Advances the record by one moment.
    pub fn tick(&mut self, s: &Sample) -> Changes {
        let mut changes = Changes::default();
        let first = self.last_tick == 0;
        let dt = if first { 0 } else { s.now.saturating_sub(self.last_tick) };
        let slept = !first && dt > GAP_MS;
        let prev = self.last_tick;
        self.last_tick = s.now;

        for t in s.tracked {
            let running = s.running.contains(&t.exe);
            match (running, self.active.contains_key(&t.exe)) {
                (true, false) => {
                    self.active.insert(t.exe.clone(), new_session(t, s, first));
                    changes.started.push(t.exe.clone());
                }
                (false, true) => {
                    if let Some(mut done) = self.active.remove(&t.exe) {
                        done.ended = Some(s.now);
                        done.ended_by = Some("The app was closed".into());
                        self.finished.push(done);
                        changes.ended.push(t.exe.clone());
                    }
                }
                (true, true) => {
                    if let Some(sess) = self.active.get_mut(&t.exe) {
                        if slept {
                            sess.segments.push(Segment { state: OFFLINE.into(), from: prev, to: s.now });
                        }
                        update(sess, s, dt.min(GAP_MS));
                    }
                }
                (false, false) => {}
            }
        }
        // An app no longer on the tracked list ends its session.
        let untracked: Vec<String> = self.active.keys().filter(|e| !s.tracked.iter().any(|t| &t.exe == *e)).cloned().collect();
        for exe in untracked {
            if let Some(mut done) = self.active.remove(&exe) {
                done.ended = Some(s.now);
                done.ended_by = Some("The app was removed from tracking".into());
                self.finished.push(done);
                changes.ended.push(exe);
            }
        }
        if !changes.ended.is_empty() {
            self.trim();
        }
        changes
    }
}

fn new_session(t: &Tracked, s: &Sample, late: bool) -> Session {
    let mut sess = Session {
        id: format!("{}-{}", s.now, t.exe.trim_end_matches(".exe")),
        exe: t.exe.clone(),
        name: t.name.clone(),
        started: s.now,
        ended: None,
        last_seen: s.now,
        ended_by: None,
        late_start: late,
        kernel_ms: 0,
        front_ms: 0,
        segments: vec![Segment { state: s.state.into(), from: s.now, to: s.now }],
        buckets: Vec::new(),
        notes: vec![Note { t: s.now, settings: s.settings.clone() }],
    };
    add_counters(&mut sess, s);
    sess
}

fn update(sess: &mut Session, s: &Sample, dt: u64) {
    sess.last_seen = s.now;
    match sess.segments.last_mut() {
        Some(last) if last.state == s.state => last.to = s.now,
        Some(last) => {
            let from = last.to;
            if sess.segments.len() < MAX_SEGMENTS {
                sess.segments.push(Segment { state: s.state.into(), from, to: s.now });
            }
        }
        None => sess.segments.push(Segment { state: s.state.into(), from: s.now, to: s.now }),
    }
    if s.kernel_active {
        sess.kernel_ms += dt;
    }
    if s.front_exe == sess.exe {
        sess.front_ms += dt;
    }
    add_counters(sess, s);
    if sess.notes.last().map(|n| &n.settings) != Some(&s.settings) && sess.notes.len() < MAX_NOTES {
        sess.notes.push(Note { t: s.now, settings: s.settings.clone() });
    }
}

fn add_counters(sess: &mut Session, s: &Sample) {
    let index = s.now.saturating_sub(sess.started) / BUCKET_MS;
    let t = sess.started + index * BUCKET_MS;
    if sess.buckets.last().map(|b| b.t) != Some(t) {
        sess.buckets.push(Bucket { t, ..Bucket::default() });
    }
    if let Some(b) = sess.buckets.last_mut() {
        b.moves = b.moves.saturating_add(s.counters.moves);
        b.sent = b.sent.saturating_add(s.counters.sent);
        b.seen = b.seen.saturating_add(s.counters.seen);
        b.refused = b.refused.saturating_add(s.counters.refused);
        b.buttons = b.buttons.saturating_add(s.counters.buttons);
        b.front |= s.front_exe == sess.exe;
    }
}

// ---- summaries for the dashboard ------------------------------------------------------------------------

fn end_of(s: &Session) -> u64 {
    s.ended.unwrap_or(s.last_seen)
}

/// Milliseconds spent in `state`.
fn time_in(s: &Session, state: &str) -> u64 {
    s.segments.iter().filter(|g| g.state == state).map(|g| g.to.saturating_sub(g.from)).sum()
}

pub fn summarize(s: &Session) -> Value {
    let duration = end_of(s).saturating_sub(s.started);
    let sum = |f: fn(&Bucket) -> u32| s.buckets.iter().map(|b| f(b) as u64).sum::<u64>();
    json!({
        "id": s.id, "exe": s.exe, "name": s.name,
        "started": s.started, "ended": s.ended, "last_seen": s.last_seen,
        "ended_by": s.ended_by, "late_start": s.late_start, "live": s.ended.is_none(),
        "duration_ms": duration,
        "working_ms": time_in(s, WORKING),
        "standby_ms": time_in(s, STANDBY),
        "paused_ms": time_in(s, PAUSED),
        "game_pause_ms": time_in(s, GAME_PAUSE),
        "blocked_ms": time_in(s, BLOCKED),
        "kernel_error_ms": time_in(s, KERNEL_ERROR),
        "offline_ms": time_in(s, OFFLINE),
        "kernel_ms": s.kernel_ms, "front_ms": s.front_ms,
        "moves": sum(|b| b.moves), "sent": sum(|b| b.sent), "seen": sum(|b| b.seen),
        "refused": sum(|b| b.refused), "buttons": sum(|b| b.buttons),
        "settings_changes": s.notes.len().saturating_sub(1),
    })
}

/// The whole record of one session, for its detail view.
pub fn detail(s: &Session) -> Value {
    let mut v = summarize(s);
    v["segments"] = Value::Array(s.segments.iter().map(|g| json!([g.state, g.from, g.to])).collect());
    v["buckets"] = Value::Array(
        s.buckets.iter().map(|b| json!([b.t, b.moves, b.sent, b.seen, b.refused, b.buttons, b.front as u8])).collect(),
    );
    v["notes"] = Value::Array(s.notes.iter().map(|n| json!({ "t": n.t, "settings": n.settings })).collect());
    v
}

// ---- reading the engine's own state -----------------------------------------------------------------------

/// What Kinetic is doing for the user right now, in the dashboard's terms.
fn current_state() -> &'static str {
    if state::user_paused() {
        PAUSED
    } else if kernel::active() {
        // The driver does the movement work, whatever the engine itself has stepped aside from.
        WORKING
    } else {
        match state::aside_reason() {
            Some("game") => GAME_PAUSE,
            Some(_) => BLOCKED,
            None if kernel::enabled() => KERNEL_ERROR,
            None if movement::ACTIVE.load(Ordering::Relaxed) => WORKING,
            None => STANDBY,
        }
    }
}

fn settings_summary() -> Value {
    let cfg = config::current();
    let profile = config::active_profile();
    let perf = cfg.perf_for(&profile);
    let dpi = movement::dpi_event();
    json!({
        "profile": profile,
        "dpi_x": dpi.get("dpi_x"), "dpi_y": dpi.get("dpi_y"),
        "accel": format!("{:?}", perf.accel.mode).to_lowercase(),
        "snap": perf.angle_snap, "snap_degrees": perf.steady.snap_degrees,
        "smoothing": (perf.smoothing * 100.0).round() / 100.0,
        "precision": perf.steady.precision, "precision_below": perf.steady.precision_below, "precision_factor": perf.steady.precision_factor,
        "speed_limit": perf.steady.speed_limit,
        "rotation": perf.rotation,
        "kernel": kernel::active(),
        "remaps": !state::user_paused() && state::aside_reason().is_none(),
        "game_pause_setting": state::guard_enabled(),
    })
}

// ---- files and the background thread ---------------------------------------------------------------------

fn dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Kinetic"))
}

fn finished_path() -> Option<PathBuf> {
    Some(dir()?.join("sessions.json"))
}

fn active_path() -> Option<PathBuf> {
    Some(dir()?.join("sessions-active.json"))
}

fn write_json<T: Serialize>(path: Option<PathBuf>, value: &T) {
    let Some(path) = path else { return };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string(value) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: Option<PathBuf>) -> T {
    path.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

static TRACKER: Mutex<Option<Tracker>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Tracker) -> R) -> Option<R> {
    TRACKER.lock().ok().and_then(|mut g| g.as_mut().map(f))
}

fn save(t: &Tracker, finished_too: bool) {
    write_json(active_path(), &t.active.values().collect::<Vec<_>>());
    if finished_too {
        write_json(finished_path(), &t.finished);
    }
}

/// The `sessions` event: a summary of every session, newest first, and what is tracked.
pub fn list_event() -> Value {
    let (sessions, live) = with(|t| {
        let mut all: Vec<&Session> = t.finished.iter().chain(t.active.values()).collect();
        all.sort_by_key(|s| std::cmp::Reverse(s.started));
        (all.iter().map(|s| summarize(s)).collect::<Vec<_>>(), t.active.keys().cloned().collect::<Vec<_>>())
    })
    .unwrap_or_default();
    json!({ "t": "sessions", "sessions": sessions, "live": live })
}

pub fn detail_event(id: &str) -> Value {
    let found = with(|t| t.finished.iter().chain(t.active.values()).find(|s| s.id == id).map(detail)).flatten();
    json!({ "t": "session", "id": id, "session": found })
}

/// Deletes every finished session. A session in progress is kept.
pub fn clear() {
    with(|t| {
        t.finished.clear();
        save(t, true);
    });
    bus::publish(&list_event());
}

/// Writes everything to disk, for when the engine is about to stop.
pub fn flush() {
    with(|t| save(t, true));
}

fn live_event(t: &Tracker, now: u64, state: &str) -> Value {
    let live: Vec<Value> = t
        .active
        .values()
        .map(|s| json!({ "id": s.id, "exe": s.exe, "name": s.name, "started": s.started, "state": state, "duration_ms": now.saturating_sub(s.started), "working_ms": time_in(s, WORKING) }))
        .collect();
    json!({ "t": "session_live", "live": live })
}

/// Starts the background watcher.
pub fn start() {
    if hook::test_mode() {
        return;
    }
    let mut tracker = Tracker::default();
    tracker.finished = read_json(finished_path());
    let open: Vec<Session> = read_json(active_path());
    let running = running_apps(&config::current().tracked);
    tracker.recover(open, now_ms(), &running);
    save(&tracker, true);
    if let Ok(mut g) = TRACKER.lock() {
        *g = Some(tracker);
    }
    std::thread::spawn(|| {
        let mut ticks = 0u64;
        let mut running: HashSet<String> = HashSet::new();
        let mut last_flush = now_ms();
        loop {
            std::thread::sleep(TICK);
            let now = now_ms();
            let tracked = config::current().tracked;
            let front = foreground::last_app();
            if tracked.is_empty() {
                // Nothing to track: end anything in progress, and stay cheap.
                let none = HashSet::new();
                let changed = with(|t| t.tick(&sample_for(now, &none, &tracked, Counters::take(), &front))).unwrap_or_default();
                if !changed.ended.is_empty() {
                    bus::publish(&list_event());
                }
                continue;
            }
            if ticks % DETECT_EVERY == 0 {
                running = running_apps(&tracked);
            }
            ticks += 1;
            let sample = sample_for(now, &running, &tracked, Counters::take(), &front);
            let (changes, live) = with(|t| {
                let c = t.tick(&sample);
                (c, if t.active.is_empty() { None } else { Some(live_event(t, now, sample.state)) })
            })
            .unwrap_or_default();
            if let Some(v) = live {
                bus::publish(&v);
            }
            if !changes.started.is_empty() || !changes.ended.is_empty() {
                bus::publish(&list_event());
                with(|t| save(t, true));
                last_flush = now;
            } else if now.saturating_sub(last_flush) >= FLUSH_EVERY_MS {
                with(|t| save(t, false));
                last_flush = now;
            }
        }
    });
}

fn sample_for<'a>(now: u64, running: &'a HashSet<String>, tracked: &'a [Tracked], counters: Counters, front: &'a str) -> Sample<'a> {
    Sample {
        now,
        running,
        tracked,
        state: current_state(),
        counters,
        front_exe: front,
        kernel_active: kernel::active(),
        settings: settings_summary(),
    }
}

/// Which of the tracked apps have a window open right now.
fn running_apps(tracked: &[Tracked]) -> HashSet<String> {
    if tracked.is_empty() {
        return HashSet::new();
    }
    let open: HashSet<String> = foreground::list_apps().into_iter().collect();
    tracked.iter().filter(|t| open.contains(&t.exe)).map(|t| t.exe.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked() -> Vec<Tracked> {
        vec![Tracked { exe: "game.exe".into(), name: "Game".into() }]
    }

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn sample<'a>(now: u64, running: &'a HashSet<String>, tracked: &'a [Tracked], state: &'a str) -> Sample<'a> {
        Sample { now, running, tracked, state, counters: Counters::default(), front_exe: "game.exe", kernel_active: false, settings: json!({ "dpi": 800 }) }
    }

    #[test]
    fn a_session_starts_when_the_app_appears_and_ends_when_it_goes() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let none = set(&[]);
        let game = set(&["game.exe"]);
        assert_eq!(tr.tick(&sample(1_000, &none, &t, WORKING)), Changes::default());
        let c = tr.tick(&sample(2_000, &game, &t, WORKING));
        assert_eq!(c.started, vec!["game.exe".to_string()]);
        assert_eq!(tr.active.len(), 1);
        tr.tick(&sample(3_000, &game, &t, WORKING));
        let c = tr.tick(&sample(9_000, &none, &t, WORKING));
        assert_eq!(c.ended, vec!["game.exe".to_string()]);
        assert!(tr.active.is_empty());
        let s = &tr.finished[0];
        assert_eq!((s.started, s.ended), (2_000, Some(9_000)));
        assert!(!s.late_start, "the app appeared while Kinetic was watching");
    }

    #[test]
    fn an_app_already_running_when_watching_begins_is_marked_as_a_late_start() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        tr.tick(&sample(1_000, &game, &t, WORKING));
        assert!(tr.active["game.exe"].late_start);
    }

    #[test]
    fn states_become_segments_and_the_same_state_extends() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        for (now, st) in [(1_000, WORKING), (2_000, WORKING), (3_000, BLOCKED), (4_000, BLOCKED), (5_000, WORKING)] {
            tr.tick(&sample(now, &game, &t, st));
        }
        let segs: Vec<(String, u64, u64)> = tr.active["game.exe"].segments.iter().map(|g| (g.state.clone(), g.from, g.to)).collect();
        assert_eq!(segs, vec![(WORKING.into(), 1_000, 2_000), (BLOCKED.into(), 2_000, 4_000), (WORKING.into(), 4_000, 5_000)]);
    }

    #[test]
    fn counters_land_in_ten_second_buckets_and_add_up() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        for sec in 0..25u64 {
            let mut s = sample(1_000 + sec * 1_000, &game, &t, WORKING);
            s.counters = Counters { moves: 10, sent: 8, seen: 8, refused: if sec == 3 { 2 } else { 0 }, buttons: 1 };
            tr.tick(&s);
        }
        let sess = &tr.active["game.exe"];
        assert_eq!(sess.buckets.len(), 3, "25 seconds is three ten second windows");
        let total: u32 = sess.buckets.iter().map(|b| b.moves).sum();
        assert_eq!(total, 250);
        let v = summarize(sess);
        assert_eq!(v["moves"], 250);
        assert_eq!(v["refused"], 2);
        assert_eq!(v["buttons"], 25);
        assert!(sess.buckets.iter().all(|b| b.front));
    }

    #[test]
    fn a_change_of_settings_is_noted_once() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        for (now, dpi) in [(1_000, 800), (2_000, 800), (3_000, 1600), (4_000, 1600)] {
            let mut s = sample(now, &game, &t, WORKING);
            s.settings = json!({ "dpi": dpi });
            tr.tick(&s);
        }
        let notes = &tr.active["game.exe"].notes;
        assert_eq!(notes.len(), 2, "the first settings, then the change");
        assert_eq!(notes[1].settings["dpi"], 1600);
        assert_eq!(summarize(&tr.active["game.exe"])["settings_changes"], 1);
    }

    #[test]
    fn time_in_each_state_and_in_kernel_mode_is_added_up() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        // One tick a second: ten seconds working, ten paused, ten working again.
        for sec in 0..=30u64 {
            let st = if (10..20).contains(&sec) { PAUSED } else { WORKING };
            let mut s = sample(1_000 + sec * 1_000, &game, &t, st);
            s.kernel_active = st == WORKING;
            tr.tick(&s);
        }
        let v = summarize(&tr.active["game.exe"]);
        assert_eq!(v["working_ms"], 20_000);
        assert_eq!(v["paused_ms"], 10_000);
        assert_eq!(v["duration_ms"], 30_000);
        assert_eq!(v["kernel_ms"], 20_000);
    }

    #[test]
    fn a_stall_longer_than_the_gap_is_recorded_as_offline() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        tr.tick(&sample(1_000, &game, &t, WORKING));
        tr.tick(&sample(2_000, &game, &t, WORKING));
        tr.tick(&sample(62_000, &game, &t, WORKING));
        let v = summarize(&tr.active["game.exe"]);
        assert_eq!(v["offline_ms"], 60_000);
    }

    #[test]
    fn a_session_found_on_disk_carries_on_if_the_app_is_still_running() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        tr.tick(&sample(1_000, &game, &t, WORKING));
        tr.tick(&sample(2_000, &game, &t, WORKING));
        let open: Vec<Session> = tr.active.values().cloned().collect();

        let mut fresh = Tracker::default();
        fresh.recover(open, 50_000, &game);
        let s = &fresh.active["game.exe"];
        assert_eq!(s.segments.last().map(|g| (g.state.as_str(), g.from, g.to)), Some((OFFLINE, 2_000, 50_000)));
        assert!(s.ended.is_none());
    }

    #[test]
    fn a_session_found_on_disk_ends_where_it_was_last_seen_if_the_app_is_gone() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        tr.tick(&sample(1_000, &game, &t, WORKING));
        tr.tick(&sample(2_000, &game, &t, WORKING));
        let open: Vec<Session> = tr.active.values().cloned().collect();

        let mut fresh = Tracker::default();
        fresh.recover(open, 50_000, &set(&[]));
        assert!(fresh.active.is_empty());
        assert_eq!(fresh.finished[0].ended, Some(2_000));
        assert!(fresh.finished[0].ended_by.as_deref().unwrap().contains("not running"));
    }

    #[test]
    fn untracking_an_app_ends_its_session() {
        let (t, mut tr) = (tracked(), Tracker::default());
        let game = set(&["game.exe"]);
        tr.tick(&sample(1_000, &game, &t, WORKING));
        let c = tr.tick(&sample(2_000, &game, &[], WORKING));
        assert_eq!(c.ended, vec!["game.exe".to_string()]);
        assert!(tr.finished[0].ended_by.as_deref().unwrap().contains("removed"));
    }

    #[test]
    fn only_the_newest_finished_sessions_are_kept() {
        let mut tr = Tracker::default();
        for i in 0..(MAX_FINISHED as u64 + 10) {
            tr.finished.push(Session {
                id: i.to_string(), exe: "g.exe".into(), name: "g".into(), started: i, ended: Some(i + 1), last_seen: i + 1, ended_by: None,
                late_start: false, kernel_ms: 0, front_ms: 0, segments: vec![], buckets: vec![], notes: vec![],
            });
        }
        tr.trim();
        assert_eq!(tr.finished.len(), MAX_FINISHED);
        assert_eq!(tr.finished[0].started, 10, "the oldest ten were dropped");
    }
}
