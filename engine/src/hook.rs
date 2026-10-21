//! Low-level mouse hook: swallows remapped buttons, handles the wheel, swallows the mouse's own
//! movement while software movement is on, and provides the input-injection helpers.

use crate::config::{self, Action, MouseButtonName};
use crate::{keys, movement, scroll, state};
use std::mem::size_of;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use windows::core::Result;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, HHOOK, LLMHF_INJECTED, MSLLHOOKSTRUCT, WH_MOUSE_LL,
};

const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_MOUSEWHEEL: u32 = 0x020A;
const WM_XBUTTONDOWN: u32 = 0x020B;
const WM_XBUTTONUP: u32 = 0x020C;
const WM_MOUSEHWHEEL: u32 = 0x020E;

/// What each physical button was turned into at press time, so its release matches
/// even if the config changes while the button is held.
static HELD: Mutex<[Option<Action>; 17]> = Mutex::new([const { None }; 17]);

/// Extra-info value a test tool puts on injected input. Only honoured when the engine was
/// started with KINETIC_TEST_MODE=1, so normal runs never accept injected button or move events.
pub const TEST_MARKER: usize = 0x4B49_4E54;

pub fn test_mode() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("KINETIC_TEST_MODE").is_some_and(|v| v == "1"))
}

pub fn install() -> Result<HHOOK> {
    unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0) }
}

/// Windows button number (1 left .. 5 forward) and whether it went down.
fn classify(message: u32, mouse_data: u32) -> Option<(u8, bool)> {
    let x_button = (mouse_data >> 16) as u16;
    match message {
        WM_LBUTTONDOWN => Some((1, true)),
        WM_LBUTTONUP => Some((1, false)),
        WM_RBUTTONDOWN => Some((2, true)),
        WM_RBUTTONUP => Some((2, false)),
        WM_MBUTTONDOWN => Some((3, true)),
        WM_MBUTTONUP => Some((3, false)),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let down = message == WM_XBUTTONDOWN;
            match x_button {
                1 => Some((4, down)),
                2 => Some((5, down)),
                _ => None,
            }
        }
        _ => None,
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // HC_ACTION is 0. Anything else must be passed on untouched.
    if code == 0 && !state::paused() {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // Skip input we injected ourselves, otherwise a remap could trigger itself. The one
        // exception is test mode, where a test tool marks its fake input with TEST_MARKER.
        let injected = info.flags & LLMHF_INJECTED != 0;
        if !injected || (test_mode() && info.dwExtraInfo == TEST_MARKER) {
            let message = wparam.0 as u32;
            if message == WM_MOUSEMOVE {
                if movement::ACTIVE.load(Ordering::Relaxed) && movement::SWALLOW.load(Ordering::Relaxed) {
                    return LRESULT(1);
                }
            } else if message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL {
                if scroll::handle(message == WM_MOUSEHWHEEL, (info.mouseData >> 16) as i16 as i32) {
                    return LRESULT(1);
                }
            } else if let Some((button, down)) = classify(message, info.mouseData) {
                if handle(button, down) {
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Returns true when the original event must be swallowed. Never blocks: a hook that
/// stalls makes the whole system's mouse stutter, so contention just passes the event on.
pub(crate) fn handle(button: u8, down: bool) -> bool {
    if button as usize >= 17 {
        return false;
    }
    let Ok(mut held) = HELD.try_lock() else { return false };
    let slot = &mut held[button as usize];

    if down {
        match config::action_for_active(button, state::shift_active()) {
            Some(a) => {
                perform(&a, true);
                *slot = Some(a);
                true
            }
            None => false,
        }
    } else {
        match slot.take() {
            Some(a) => {
                perform(&a, false);
                true
            }
            None => false,
        }
    }
}

/// Runs an action for a press (`down`) or release. Used for physical buttons and learned extras alike.
pub fn perform(action: &Action, down: bool) {
    match action {
        Action::Disabled => {}
        Action::Macro { id } => crate::macros::trigger(id, down),
        Action::Mouse { button } => send(&[mouse_input(*button, down)]),
        Action::Shift => state::shift_button(down),
        Action::Launch { path } => {
            // Only on press. The program is started directly, never through a shell.
            if down {
                let _ = std::process::Command::new(path).spawn();
            }
        }
        Action::Dpi { op, stage } => dpi_action(op, *stage, down),
        Action::Key { keys: names } => {
            let codes: Vec<(u16, bool)> = names.iter().filter_map(|n| keys::lookup(n)).collect();
            let inputs: Vec<INPUT> = if down {
                codes.iter().map(|&(vk, ext)| key_input(vk, ext, false)).collect()
            } else {
                codes.iter().rev().map(|&(vk, ext)| key_input(vk, ext, true)).collect()
            };
            send(&inputs);
        }
    }
}

fn dpi_action(op: &str, stage: usize, down: bool) {
    match (op, down) {
        ("cycle", true) => movement::step_stage(true, true),
        ("up", true) => movement::step_stage(true, false),
        ("down", true) => movement::step_stage(false, false),
        ("set", true) => movement::set_stage(stage),
        ("hold", true) => movement::hold_stage(Some(stage)),
        ("hold", false) => movement::hold_stage(None),
        _ => {}
    }
}

pub(crate) fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    unsafe {
        SendInput(inputs, size_of::<INPUT>() as i32);
    }
}

pub(crate) fn key_input(vk: u16, extended: bool, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

pub(crate) fn move_input(dx: i32, dy: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Wheel movement in raw wheel units (120 per notch). `horizontal` is the tilt wheel.
pub(crate) fn wheel_input(delta: i32, horizontal: bool) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub(crate) fn mouse_input(button: MouseButtonName, down: bool) -> INPUT {
    let (flags, data): (MOUSE_EVENT_FLAGS, u32) = match (button, down) {
        (MouseButtonName::Left, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (MouseButtonName::Left, false) => (MOUSEEVENTF_LEFTUP, 0),
        (MouseButtonName::Right, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (MouseButtonName::Right, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (MouseButtonName::Middle, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (MouseButtonName::Middle, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (MouseButtonName::Back, true) => (MOUSEEVENTF_XDOWN, 1),
        (MouseButtonName::Back, false) => (MOUSEEVENTF_XUP, 1),
        (MouseButtonName::Forward, true) => (MOUSEEVENTF_XDOWN, 2),
        (MouseButtonName::Forward, false) => (MOUSEEVENTF_XUP, 2),
    };
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::classify;

    #[test]
    fn classifies_standard_and_side_buttons() {
        assert_eq!(classify(0x0201, 0), Some((1, true)));
        assert_eq!(classify(0x0205, 0), Some((2, false)));
        assert_eq!(classify(0x020B, 1 << 16), Some((4, true)));
        assert_eq!(classify(0x020C, 2 << 16), Some((5, false)));
        assert_eq!(classify(0x020B, 3 << 16), None);
        assert_eq!(classify(0x0200, 0), None);
    }
}
