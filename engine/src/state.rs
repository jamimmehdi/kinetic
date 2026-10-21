//! Small pieces of live engine state shared between the hook, the raw-input handler and the pipe.

use crate::bus;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::time::Duration;

static PAUSED: AtomicBool = AtomicBool::new(false);
/// Why the engine stepped aside on its own: 0 not, 1 a protected game is in front, 2 injected input
/// was being dropped.
static ASIDE: AtomicU8 = AtomicU8::new(0);
/// Whether to step aside for protected games at all. On by default; the user can turn it off.
static GUARD: AtomicBool = AtomicBool::new(true);
const GAME: u8 = 1;
const BLOCKED: u8 = 2;
/// After input was blocked, try again this long later even if the user stays in the same window.
const RETRY_AFTER: Duration = Duration::from_secs(20);
/// Number of Shift-layer buttons currently held.
static SHIFT_HELD: AtomicU32 = AtomicU32::new(0);

/// True when the engine must leave input alone: paused by the user, or a protected game is in front.
pub fn paused() -> bool {
    PAUSED.load(Ordering::Relaxed) || ASIDE.load(Ordering::Relaxed) != 0
}

pub fn aside_reason() -> Option<&'static str> {
    match ASIDE.load(Ordering::Relaxed) {
        GAME => Some("game"),
        BLOCKED => Some("blocked"),
        _ => None,
    }
}

/// A protected game came to the front or left it. Leaving also ends a "blocked" step-aside, so
/// switching windows is a retry.
pub fn set_game(on: bool) {
    set_aside(if on && guard_enabled() { GAME } else { 0 });
}

pub fn guard_enabled() -> bool {
    GUARD.load(Ordering::Relaxed)
}

/// Turn stepping aside for protected games on or off. Turning it off ends a game pause now.
pub fn set_guard(enabled: bool) {
    GUARD.store(enabled, Ordering::Relaxed);
    if !enabled && ASIDE.load(Ordering::Relaxed) == GAME {
        set_aside(0);
    } else if enabled {
        crate::foreground::refresh_game();
    }
}

/// Injected input is being dropped (anti-cheat driver or similar). Step aside, and retry later.
pub fn set_blocked() {
    set_aside(BLOCKED);
    std::thread::spawn(|| {
        std::thread::sleep(RETRY_AFTER);
        if ASIDE.load(Ordering::Relaxed) == BLOCKED {
            set_aside(0);
        }
    });
}

fn set_aside(reason: u8) {
    let was = ASIDE.swap(reason, Ordering::Relaxed);
    if was == reason {
        return;
    }
    if reason != 0 {
        SHIFT_HELD.store(0, Ordering::Relaxed);
        crate::macros::stop_all();
    }
    crate::activity::record("engine", json!({ "stepped_aside": aside_reason() }));
    crate::movement::apply_config();
    bus::publish(&event());
    bus::publish(&layer_event());
}

/// Pause or resume everything the engine does to input.
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
    if paused {
        SHIFT_HELD.store(0, Ordering::Relaxed);
        crate::macros::stop_all();
    }
    crate::movement::apply_config();
    bus::publish(&event());
    bus::publish(&layer_event());
}

pub fn shift_active() -> bool {
    SHIFT_HELD.load(Ordering::Relaxed) > 0
}

/// A Shift-layer button went down or up.
pub fn shift_button(down: bool) {
    if down {
        SHIFT_HELD.fetch_add(1, Ordering::Relaxed);
    } else {
        // Never below zero, even if an up arrives without its down.
        let _ = SHIFT_HELD.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| Some(n.saturating_sub(1)));
    }
    bus::publish(&layer_event());
}

pub fn event() -> serde_json::Value {
    json!({ "t": "engine", "paused": paused(), "game": aside_reason().is_some(), "reason": aside_reason() })
}

pub fn layer_event() -> serde_json::Value {
    json!({ "t": "layer", "shift": shift_active() })
}
