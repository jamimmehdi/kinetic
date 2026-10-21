//! Temporary Windows pointer and wheel settings. Everything here is applied for the current session
//! only (never written to the user's profile) and put back on exit. The original values are also
//! saved to a file so a crashed engine can restore them on its next start.

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::Mutex;
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETMOUSE, SPI_GETMOUSESPEED, SPI_GETWHEELSCROLLLINES, SPI_SETMOUSE,
    SPI_SETMOUSESPEED, SPI_SETWHEELSCROLLLINES, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Saved {
    mouse: [i32; 3],
    speed: u32,
    lines: u32,
}

struct State {
    original: Option<Saved>,
    accel_off: bool,
    lines: Option<u32>,
}

static STATE: Mutex<State> = Mutex::new(State { original: None, accel_off: false, lines: None });

fn backup_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Kinetic").join("spi-backup.json"))
}

fn no_flags() -> SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS {
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)
}

fn read_current() -> Option<Saved> {
    unsafe {
        let mut mouse = [0i32; 3];
        let mut speed = 0u32;
        let mut lines = 0u32;
        SystemParametersInfoW(SPI_GETMOUSE, 0, Some(mouse.as_mut_ptr() as *mut c_void), no_flags()).ok()?;
        SystemParametersInfoW(SPI_GETMOUSESPEED, 0, Some(&mut speed as *mut u32 as *mut c_void), no_flags()).ok()?;
        SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, Some(&mut lines as *mut u32 as *mut c_void), no_flags()).ok()?;
        Some(Saved { mouse, speed, lines })
    }
}

fn write_all(s: &Saved) {
    unsafe {
        let mut mouse = s.mouse;
        let _ = SystemParametersInfoW(SPI_SETMOUSE, 0, Some(mouse.as_mut_ptr() as *mut c_void), no_flags());
        let _ = SystemParametersInfoW(SPI_SETMOUSESPEED, 0, Some(s.speed as usize as *mut c_void), no_flags());
        let _ = SystemParametersInfoW(SPI_SETWHEELSCROLLLINES, s.lines, None, no_flags());
    }
}

/// Remember the user's own settings the first time anything is changed.
fn ensure_original(state: &mut State) {
    if state.original.is_some() {
        return;
    }
    state.original = read_current();
    if let (Some(path), Some(saved)) = (backup_path(), state.original) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::to_string(&saved).unwrap_or_default());
    }
}

/// Call once at startup: if a previous run died with settings changed, put them back.
pub fn recover() {
    let Some(path) = backup_path() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    if let Ok(saved) = serde_json::from_str::<Saved>(&text) {
        write_all(&saved);
        println!("engine: restored pointer settings left by a previous run");
    }
    let _ = std::fs::remove_file(path);
}

/// Turn Windows pointer acceleration off (1:1 movement) or back to the user's own setting.
pub fn set_accel_off(off: bool) {
    let Ok(mut st) = STATE.lock() else { return };
    if st.accel_off == off {
        return;
    }
    ensure_original(&mut st);
    let Some(orig) = st.original else { return };
    unsafe {
        if off {
            // Thresholds 0 and acceleration 0 disable "enhance pointer precision"; speed 10 is 1:1.
            let mut mouse = [0i32; 3];
            let _ = SystemParametersInfoW(SPI_SETMOUSE, 0, Some(mouse.as_mut_ptr() as *mut c_void), no_flags());
            let _ = SystemParametersInfoW(SPI_SETMOUSESPEED, 0, Some(10usize as *mut c_void), no_flags());
        } else {
            let mut mouse = orig.mouse;
            let _ = SystemParametersInfoW(SPI_SETMOUSE, 0, Some(mouse.as_mut_ptr() as *mut c_void), no_flags());
            let _ = SystemParametersInfoW(SPI_SETMOUSESPEED, 0, Some(orig.speed as usize as *mut c_void), no_flags());
        }
    }
    st.accel_off = off;
}

/// Lines scrolled per wheel notch while a profile is active. `None` goes back to the user's own value.
pub fn set_scroll_lines(lines: Option<u32>) {
    let Ok(mut st) = STATE.lock() else { return };
    if st.lines == lines {
        return;
    }
    ensure_original(&mut st);
    let Some(orig) = st.original else { return };
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETWHEELSCROLLLINES, lines.unwrap_or(orig.lines), None, no_flags());
    }
    st.lines = lines;
}

/// Put everything back. Called on exit.
pub fn restore_all() {
    let Ok(mut st) = STATE.lock() else { return };
    if let Some(orig) = st.original {
        write_all(&orig);
    }
    st.accel_off = false;
    st.lines = None;
    if let Some(path) = backup_path() {
        let _ = std::fs::remove_file(path);
    }
}
