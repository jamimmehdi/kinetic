//! Macro player. Runs on its own threads so the mouse hook never waits on a macro.

use crate::config::{self, MacroDef, MacroEvent, MouseButtonName, Repeat};
use crate::{bus, hook, keys};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Media::timeBeginPeriod;

enum Cmd {
    /// A button mapped to this macro went down or up.
    Trigger { id: String, down: bool },
    /// Run once regardless of the repeat mode (the editor's test button).
    RunOnce { id: String },
    StopAll,
}

static TX: OnceLock<Sender<Cmd>> = OnceLock::new();

struct Running {
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

pub fn start() {
    let (tx, rx) = channel();
    if TX.set(tx).is_err() {
        return;
    }
    thread::spawn(move || {
        // Without this, Windows sleeps in ~15 ms steps and millisecond delays would drift.
        unsafe {
            timeBeginPeriod(1);
        }
        let mut running: HashMap<String, Running> = HashMap::new();
        while let Ok(cmd) = rx.recv() {
            running.retain(|_, r| !r.done.load(Ordering::Relaxed));
            match cmd {
                Cmd::Trigger { id, down } => trigger_cmd(&mut running, &id, down),
                Cmd::RunOnce { id } => {
                    if let Some(def) = lookup(&id) {
                        if !running.contains_key(&id) {
                            launch(&mut running, def, Some(1));
                        }
                    }
                }
                Cmd::StopAll => {
                    for r in running.values() {
                        r.cancel.store(true, Ordering::Relaxed);
                    }
                }
            }
        }
    });
}

fn lookup(id: &str) -> Option<MacroDef> {
    config::current().macro_def(id).cloned()
}

fn trigger_cmd(running: &mut HashMap<String, Running>, id: &str, down: bool) {
    let Some(def) = lookup(id) else { return };
    let active = running.get(id);
    match (&def.repeat, down) {
        (Repeat::Once, true) => {
            if active.is_none() {
                launch(running, def, Some(1));
            }
        }
        (Repeat::Loop { count }, true) => match active {
            Some(r) => r.cancel.store(true, Ordering::Relaxed),
            None => {
                let n = *count;
                launch(running, def, Some(n));
            }
        },
        (Repeat::Toggle, true) => match active {
            Some(r) => r.cancel.store(true, Ordering::Relaxed),
            None => launch(running, def, None),
        },
        (Repeat::Held, true) => {
            if active.is_none() {
                launch(running, def, None);
            }
        }
        (Repeat::Held, false) => {
            if let Some(r) = active {
                r.cancel.store(true, Ordering::Relaxed);
            }
        }
        _ => {}
    }
}

fn launch(running: &mut HashMap<String, Running>, def: MacroDef, loops: Option<u32>) {
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    running.insert(def.id.clone(), Running { cancel: cancel.clone(), done: done.clone() });
    thread::spawn(move || {
        bus::publish(&json!({ "t": "macro", "id": def.id, "running": true }));
        run(&def, loops, &cancel);
        done.store(true, Ordering::Relaxed);
        bus::publish(&json!({ "t": "macro", "id": def.id, "running": false }));
    });
}

/// Called from the mouse hook. Only queues a command, so it never blocks.
pub fn trigger(id: &str, down: bool) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cmd::Trigger { id: id.to_string(), down });
    }
}

pub fn run_once(id: &str) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cmd::RunOnce { id: id.to_string() });
    }
}

pub fn stop_all() {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cmd::StopAll);
    }
}

/// Sleep that wakes early when cancelled.
fn pause(ms: u32, cancel: &AtomicBool) {
    let end = Instant::now() + Duration::from_millis(ms as u64);
    while !cancel.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= end {
            break;
        }
        thread::sleep((end - now).min(Duration::from_millis(5)));
    }
}

fn run(def: &MacroDef, loops: Option<u32>, cancel: &AtomicBool) {
    if def.events.is_empty() {
        return;
    }
    // Keys and buttons this run is holding, released at the end so a cancel never leaves one stuck.
    let mut held_keys: Vec<(u16, bool)> = Vec::new();
    let mut held_mouse: Vec<MouseButtonName> = Vec::new();

    let mut done = 0u32;
    'outer: loop {
        for event in &def.events {
            if cancel.load(Ordering::Relaxed) {
                break 'outer;
            }
            match event {
                MacroEvent::KeyDown { key } => {
                    if let Some((vk, ext)) = keys::lookup(key) {
                        hook::send(&[hook::key_input(vk, ext, false)]);
                        if !held_keys.contains(&(vk, ext)) {
                            held_keys.push((vk, ext));
                        }
                    }
                }
                MacroEvent::KeyUp { key } => {
                    if let Some((vk, ext)) = keys::lookup(key) {
                        hook::send(&[hook::key_input(vk, ext, true)]);
                        held_keys.retain(|k| *k != (vk, ext));
                    }
                }
                MacroEvent::MouseDown { button } => {
                    hook::send(&[hook::mouse_input(*button, true)]);
                    if !held_mouse.contains(button) {
                        held_mouse.push(*button);
                    }
                }
                MacroEvent::MouseUp { button } => {
                    hook::send(&[hook::mouse_input(*button, false)]);
                    held_mouse.retain(|b| b != button);
                }
                MacroEvent::Move { dx, dy } => hook::send(&[hook::move_input(*dx, *dy)]),
                MacroEvent::Delay { ms } => pause(*ms, cancel),
            }
        }
        done += 1;
        if let Some(n) = loops {
            if done >= n {
                break;
            }
        }
        // A loop with no delays would otherwise flood the system with input.
        pause(1, cancel);
    }

    for &(vk, ext) in held_keys.iter().rev() {
        hook::send(&[hook::key_input(vk, ext, true)]);
    }
    for &b in held_mouse.iter().rev() {
        hook::send(&[hook::mouse_input(b, false)]);
    }
}
