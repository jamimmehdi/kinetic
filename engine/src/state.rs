//! Small pieces of live engine state shared between the hook, the raw-input handler and the pipe.

use crate::bus;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static PAUSED: AtomicBool = AtomicBool::new(false);
/// A game with kernel-level anti-cheat is in front. The engine steps aside completely there.
static GAME: AtomicBool = AtomicBool::new(false);
/// Number of Shift-layer buttons currently held.
static SHIFT_HELD: AtomicU32 = AtomicU32::new(0);

/// True when the engine must leave input alone: paused by the user, or a protected game is in front.
pub fn paused() -> bool {
    PAUSED.load(Ordering::Relaxed) || GAME.load(Ordering::Relaxed)
}

pub fn game_active() -> bool {
    GAME.load(Ordering::Relaxed)
}

/// A protected game came to the front or left it.
pub fn set_game(on: bool) {
    if GAME.swap(on, Ordering::Relaxed) == on {
        return;
    }
    if on {
        SHIFT_HELD.store(0, Ordering::Relaxed);
        crate::macros::stop_all();
    }
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
    json!({ "t": "engine", "paused": paused(), "game": game_active() })
}

pub fn layer_event() -> serde_json::Value {
    json!({ "t": "layer", "shift": shift_active() })
}
