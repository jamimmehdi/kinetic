//! Watches which app is in front and switches the active profile to match.

use crate::{bus, config};
use serde_json::{json, Value};
use std::sync::Mutex;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT,
};

/// Kinetic's own windows never change the profile, so editing settings does not flip it.
const OWN_APPS: [&str; 3] = ["electron.exe", "kinetic.exe", "kinetic-app.exe"];

/// Games whose anti-cheat (Riot Vanguard, EasyAntiCheat, BattlEye and similar) blocks or punishes
/// software that hooks, swallows or injects mouse input. While one is in front the engine does
/// nothing at all, so the mouse behaves exactly as without Kinetic.
const PROTECTED_GAMES: [&str; 24] = [
    "valorant.exe",
    "valorant-win64-shipping.exe",
    "league of legends.exe",
    "fortniteclient-win64-shipping.exe",
    "r5apex.exe",
    "r5apex_dx12.exe",
    "eldenring.exe",
    "destiny2.exe",
    "bf2042.exe",
    "bfv.exe",
    "battlefield 6.exe",
    "modernwarfare.exe",
    "cod.exe",
    "cod22-cod.exe",
    "rainbowsix.exe",
    "rainbowsix_vulkan.exe",
    "tslgame.exe",
    "escapefromtarkov.exe",
    "fallguys_client_game.exe",
    "thefinals.exe",
    "marvelrivals_launcher.exe",
    "marvel-win64-shipping.exe",
    "deadlock.exe",
    "dayz_x64.exe",
];

pub fn is_protected_game(exe: &str) -> bool {
    PROTECTED_GAMES.contains(&exe)
}

/// Last real app that was in front.
static LAST_APP: Mutex<String> = Mutex::new(String::new());

pub fn install() {
    unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        apply(GetForegroundWindow());
    }
}

unsafe extern "system" fn on_foreground(_hook: HWINEVENTHOOK, _event: u32, hwnd: HWND, _id_object: i32, _id_child: i32, _thread: u32, _time: u32) {
    apply(hwnd);
}

/// Lower-case executable file name of the process that owns `hwnd`.
fn exe_of(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(|n| n.to_ascii_lowercase())
    }
}

fn apply(hwnd: HWND) {
    let Some(exe) = exe_of(hwnd) else { return };
    if OWN_APPS.contains(&exe.as_str()) {
        return;
    }
    crate::state::set_game(is_protected_game(&exe));
    if let Ok(mut last) = LAST_APP.lock() {
        *last = exe;
    }
    refresh();
}

/// Re-evaluates the active profile for the last known app and tells every client.
pub fn refresh() {
    let exe = LAST_APP.lock().map(|l| l.clone()).unwrap_or_default();
    let profile = config::current().profile_for_app(&exe).to_string();
    let changed = config::active_profile() != profile;
    config::set_active_profile(&profile);
    if changed {
        // New profile: its own DPI stage, acceleration and scroll settings take over.
        crate::movement::on_profile_changed();
    }
    bus::publish(&active_event());
}

pub fn active_event() -> Value {
    let app = LAST_APP.lock().map(|l| l.clone()).unwrap_or_default();
    json!({ "t": "active", "profile": config::active_profile(), "app": app })
}

/// Names of apps that currently have a visible window, for the "link an app" picker.
pub fn list_apps() -> Vec<String> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<String>);
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            if let Some(exe) = exe_of(hwnd) {
                if !OWN_APPS.contains(&exe.as_str()) && !out.contains(&exe) {
                    out.push(exe);
                }
            }
        }
        BOOL(1)
    }
    let mut apps: Vec<String> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut apps as *mut Vec<String> as isize));
    }
    apps.sort();
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_games_are_recognised() {
        assert!(is_protected_game("valorant-win64-shipping.exe"));
        assert!(!is_protected_game("notepad.exe"));
    }
}
