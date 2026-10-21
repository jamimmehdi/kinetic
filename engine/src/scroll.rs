//! Wheel handling: reverse direction and smooth scrolling. Lines per notch is a Windows setting
//! applied through `spi`, not handled here.

use crate::config::{self, Scroll};
use crate::hook;
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

/// One notch is 120 wheel units. Smooth scrolling sends a notch as this many smaller steps.
const SMOOTH_STEPS: i32 = 8;
const SMOOTH_GAP: Duration = Duration::from_millis(12);

struct Job {
    delta: i32,
    horizontal: bool,
}

static TX: OnceLock<Sender<Job>> = OnceLock::new();

pub fn start() {
    let (tx, rx) = channel::<Job>();
    if TX.set(tx).is_err() {
        return;
    }
    thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            // Split the notch so the pieces add up exactly to the original distance.
            let mut left = job.delta;
            for i in 0..SMOOTH_STEPS {
                let part = left / (SMOOTH_STEPS - i);
                left -= part;
                if part != 0 {
                    hook::send(&[hook::wheel_input(part, job.horizontal)]);
                }
                thread::sleep(SMOOTH_GAP);
            }
        }
    });
}

fn settings() -> Option<Scroll> {
    let active = config::active_profile();
    let cfg = config::shared().try_read().ok()?;
    Some(cfg.perf_for(&active).scroll)
}

/// Returns true when the hook must swallow the original wheel event because we send our own.
pub fn handle(horizontal: bool, delta: i32) -> bool {
    let Some(s) = settings() else { return false };
    if !s.reverse && !s.smooth {
        return false;
    }
    crate::activity::wheel_handled();
    let delta = if s.reverse && !horizontal { -delta } else { delta };
    if s.smooth && !horizontal {
        if let Some(tx) = TX.get() {
            return tx.send(Job { delta, horizontal }).is_ok();
        }
    }
    hook::send(&[hook::wheel_input(delta, horizontal)]);
    true
}

/// How a notch is divided, for tests.
#[cfg(test)]
fn split(delta: i32) -> Vec<i32> {
    let mut left = delta;
    (0..SMOOTH_STEPS)
        .map(|i| {
            let part = left / (SMOOTH_STEPS - i);
            left -= part;
            part
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::split;

    #[test]
    fn smooth_steps_add_up_to_the_notch() {
        for d in [120, -120, 240, 7, -7, 1] {
            let parts = split(d);
            assert_eq!(parts.iter().sum::<i32>(), d, "notch {d}");
            assert_eq!(parts.len(), 8);
        }
        assert_eq!(split(120), vec![15; 8]);
    }
}
