//! Raw Input: detects every mouse and reports each button press, whatever the remapping does.

use crate::movement::RawMove;
use crate::{bus, hook, learn, models, movement};
use serde_json::json;
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::core::{w, Result};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::{
    GetRawInputData, GetRawInputDeviceInfoW, GetRawInputDeviceList, RegisterRawInputDevices, HRAWINPUT,
    RAWINPUT, RAWINPUTDEVICE, RAWINPUTDEVICELIST, RAWINPUTHEADER, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RIDEV_PAGEONLY, RIDEV_REMOVE,
    RIDI_DEVICEINFO, RIDI_DEVICENAME, RID_DEVICE_INFO, RID_HEADER, RID_INPUT, RIM_TYPEHID, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_HOTKEY, WM_INPUT,
    WM_INPUT_DEVICE_CHANGE, WNDCLASSW,
};

/// Ctrl+Alt+Shift+P pauses or resumes the engine, even when the pointer is not moving.
const EMERGENCY_KEY: u32 = 0x50;

// usButtonFlags bits (RI_MOUSE_*), pairs of (down, up) for buttons 1 to 5.
const BUTTON_FLAGS: [(u16, u16); 5] = [(0x001, 0x002), (0x004, 0x008), (0x010, 0x020), (0x040, 0x080), (0x100, 0x200)];
const RI_MOUSE_WHEEL: u16 = 0x0400;
/// RAWMOUSE.usFlags bit: set when the movement is absolute (tablets, remote desktop, virtual machines).
const MOUSE_MOVE_ABSOLUTE: u16 = 0x01;

/// The Raw Input window. Needed again later to change which HID pages are registered.
static WINDOW: AtomicIsize = AtomicIsize::new(0);

pub fn create_window() -> Result<HWND> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: w!("KineticEngineInput"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("KineticEngineInput"),
            w!("Kinetic engine"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        )?;
        WINDOW.store(hwnd.0 as isize, Ordering::Relaxed);
        register(hwnd)?;
        // If another program already owns the hotkey the engine still runs, just without it.
        let _ = RegisterHotKey(Some(hwnd), 1, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, EMERGENCY_KEY);
        Ok(hwnd)
    }
}

/// Registers for the whole Generic Desktop usage page. That covers mice and also the collections
/// some mice use for extra buttons, which Windows lists under usage 0 of this page.
unsafe fn register(hwnd: HWND) -> Result<()> {
    // INPUTSINK keeps events coming when no window of ours is focused.
    let desktop = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0,
        dwFlags: RIDEV_PAGEONLY | RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
        hwndTarget: hwnd,
    };
    RegisterRawInputDevices(&[desktop], size_of::<RAWINPUTDEVICE>() as u32)
}

/// While learning a button, also listen on the consumer and vendor-defined usage pages.
pub fn set_learn_pages(on: bool) {
    let hwnd = HWND(WINDOW.load(Ordering::Relaxed) as *mut c_void);
    if hwnd.0.is_null() {
        return;
    }
    let pages: [u16; 5] = [0x000C, 0xFF00, 0xFF01, 0xFF02, 0xFF03];
    let devices: Vec<RAWINPUTDEVICE> = pages
        .iter()
        .map(|&page| RAWINPUTDEVICE {
            usUsagePage: page,
            usUsage: 0,
            dwFlags: if on { RIDEV_PAGEONLY | RIDEV_INPUTSINK } else { RIDEV_REMOVE | RIDEV_PAGEONLY },
            hwndTarget: if on { hwnd } else { HWND::default() },
        })
        .collect();
    unsafe {
        let _ = RegisterRawInputDevices(&devices, size_of::<RAWINPUTDEVICE>() as u32);
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_INPUT => handle_raw(lparam),
        WM_INPUT_DEVICE_CHANGE => publish_devices(),
        WM_HOTKEY => crate::state::emergency_toggle(),
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn handle_raw(lparam: LPARAM) {
    let handle = HRAWINPUT(lparam.0 as *mut c_void);
    let header = size_of::<RAWINPUTHEADER>() as u32;
    let mut size = 0u32;

    // Registering for the whole Generic Desktop page also delivers keyboards. Read only the
    // header first so keystroke data is never copied.
    let mut head = RAWINPUTHEADER::default();
    let mut head_size = header;
    if GetRawInputData(handle, RID_HEADER, Some(&mut head as *mut _ as *mut c_void), &mut head_size, header) == u32::MAX
        || head.dwType == RIM_TYPEKEYBOARD.0
    {
        return;
    }

    if GetRawInputData(handle, RID_INPUT, None, &mut size, header) != 0 || size == 0 {
        return;
    }
    // u64 backing keeps the buffer aligned for RAWINPUT.
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    if GetRawInputData(handle, RID_INPUT, Some(buf.as_mut_ptr() as *mut c_void), &mut size, header) != size {
        return;
    }
    let raw = &*(buf.as_ptr() as *const RAWINPUT);
    let device = format!("{:x}", raw.header.hDevice.0 as usize);
    if raw.header.dwType == RIM_TYPEHID.0 {
        handle_hid(raw, &device);
        return;
    }
    if raw.header.dwType != RIM_TYPEMOUSE.0 {
        return;
    }
    let mouse = raw.data.mouse;
    let flags = mouse.Anonymous.Anonymous.usButtonFlags;
    let data = mouse.Anonymous.Anonymous.usButtonData as i16;

    // Input injected by software (ours included) has no device handle. Test mode accepts input
    // carrying the test marker so the whole path can be checked without a physical mouse.
    let from_device = raw.header.hDevice.0 as usize != 0
        || (hook::test_mode() && mouse.ulExtraInformation as usize == hook::TEST_MARKER);
    if from_device {
        crate::measure::feed(&device, mouse.lLastX, mouse.lLastY);
    }
    movement::on_raw(RawMove {
        dx: mouse.lLastX,
        dy: mouse.lLastY,
        relative: mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE == 0,
        from_device,
    });

    for (i, (down, up)) in BUTTON_FLAGS.iter().enumerate() {
        let button = (i + 1) as u8;
        if flags & down != 0 {
            bus::publish(&json!({ "t": "button", "device": device, "button": button, "down": true }));
        }
        if flags & up != 0 {
            bus::publish(&json!({ "t": "button", "device": device, "button": button, "down": false }));
        }
    }
    if flags & RI_MOUSE_WHEEL != 0 {
        bus::publish(&json!({ "t": "wheel", "device": device, "delta": data }));
    }
}

/// A raw HID report. While learning it is recorded; known extra buttons become button events and
/// run whatever action is mapped to them (the mouse's own behaviour cannot be suppressed).
unsafe fn handle_hid(raw: &RAWINPUT, device: &str) {
    let hid = &raw.data.hid;
    let size = hid.dwSizeHid as usize;
    if size == 0 || hid.dwCount == 0 {
        return;
    }
    let path = device_path(raw.header.hDevice);
    let data = std::slice::from_raw_parts(hid.bRawData.as_ptr(), size * hid.dwCount as usize);
    for report in data.chunks(size) {
        if learn::listening() {
            learn::observe(&path, report);
        }
        let (button, down) = match models::decode(&path, report) {
            Some(models::Change::Down(b)) => (b, true),
            Some(models::Change::Up(b)) => (b, false),
            None => continue,
        };
        bus::publish(&json!({ "t": "button", "device": device, "button": button, "down": down }));
        hook::handle(button, down);
    }
}

/// Everything the engine knows about connected mice, as the `devices` event.
pub fn devices_event() -> serde_json::Value {
    json!({ "t": "devices", "devices": list_devices() })
}

pub fn publish_devices() {
    bus::publish(&devices_event());
}

fn list_devices() -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let learned = crate::config::current().learned;
    unsafe {
        let entry = size_of::<RAWINPUTDEVICELIST>() as u32;
        let mut count = 0u32;
        if GetRawInputDeviceList(None, &mut count, entry) == u32::MAX || count == 0 {
            return out;
        }
        let mut list = vec![RAWINPUTDEVICELIST::default(); count as usize];
        let got = GetRawInputDeviceList(Some(list.as_mut_ptr()), &mut count, entry);
        if got == u32::MAX {
            return out;
        }
        for item in list.iter().take(got as usize) {
            if item.dwType != RIM_TYPEMOUSE {
                continue;
            }
            let path = device_path(item.hDevice);
            // Remote-desktop and other virtual pointers are not real mice.
            if path.contains("RDP_MOU") || path.contains("Root#") {
                continue;
            }
            let (vid, pid) = models::vid_pid(&path).unwrap_or((0, 0));
            let buttons = button_count(item.hDevice);
            // One physical mouse often shows up as several entries (one per interface).
            if vid != 0 {
                if let Some(existing) = out.iter_mut().find(|d| d["vid"] == vid && d["pid"] == pid) {
                    let prev = existing["buttons"].as_u64().unwrap_or(0) as u32;
                    existing["buttons"] = json!(prev.max(buttons));
                    continue;
                }
            }
            let extras: Vec<serde_json::Value> = models::extras_for(vid, pid, &learned)
                .into_iter()
                .map(|(button, label)| json!({ "button": button, "label": label }))
                .collect();
            out.push(json!({
                "id": format!("{:x}", item.hDevice.0 as usize),
                "name": friendly_name(&path),
                "vid": vid,
                "pid": pid,
                "buttons": buttons,
                "extras": extras,
            }));
        }
    }
    out
}

pub(crate) unsafe fn device_path(device: HANDLE) -> String {
    let mut len = 0u32;
    GetRawInputDeviceInfoW(Some(device), RIDI_DEVICENAME, None, &mut len);
    if len == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize];
    let n = GetRawInputDeviceInfoW(Some(device), RIDI_DEVICENAME, Some(buf.as_mut_ptr() as *mut c_void), &mut len);
    if n == u32::MAX {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..(n as usize).min(buf.len())]).trim_end_matches('\0').to_string()
}

unsafe fn button_count(device: HANDLE) -> u32 {
    let mut info = RID_DEVICE_INFO { cbSize: size_of::<RID_DEVICE_INFO>() as u32, ..Default::default() };
    let mut size = info.cbSize;
    let n = GetRawInputDeviceInfoW(Some(device), RIDI_DEVICEINFO, Some(&mut info as *mut _ as *mut c_void), &mut size);
    if n == u32::MAX {
        return 0;
    }
    info.Anonymous.mouse.dwNumberOfButtons
}

/// "\\?\HID#VID_046D&PID_C52B&MI_00#..." becomes "Mouse 046D:C52B". A real product name
/// from the device descriptor comes with the device-driver phase.
fn friendly_name(path: &str) -> String {
    let upper = path.to_ascii_uppercase();
    let find = |tag: &str| {
        upper.find(tag).map(|i| upper[i + tag.len()..].chars().take(4).collect::<String>())
    };
    match (find("VID_"), find("PID_")) {
        (Some(v), Some(p)) => format!("Mouse {v}:{p}"),
        _ => "Mouse".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::friendly_name;

    #[test]
    fn names_from_vid_pid() {
        assert_eq!(friendly_name(r"\\?\HID#VID_046D&PID_C52B&MI_00#7&abc"), "Mouse 046D:C52B");
        assert_eq!(friendly_name(r"\\?\ACPI#PNP0F13#4"), "Mouse");
    }
}
