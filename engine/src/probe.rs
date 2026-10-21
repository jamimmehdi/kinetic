//! `kinetic-engine probe [seconds] [vid]`: prints every raw HID report and keystroke from devices
//! of one vendor (default Razer, 1532). Used to find out how a mouse reports buttons Windows
//! does not know about, such as a DPI button. Output is limited to that vendor's devices so the
//! probe never records what you type on other keyboards.

use crate::input::device_path;
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
    RIDEV_INPUTSINK, RIDEV_PAGEONLY, RID_INPUT, RIM_TYPEHID, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostThreadMessageW, RegisterClassW,
    TranslateMessage, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WM_QUIT, WNDCLASSW,
};

static VENDOR: OnceLock<String> = OnceLock::new();
static LAST: Mutex<Vec<u8>> = Mutex::new(Vec::new());

pub fn run(seconds: u64, vendor: &str) {
    let tag = format!("VID_{}", vendor.to_ascii_uppercase());
    let _ = VENDOR.set(tag.clone());
    unsafe {
        let instance = GetModuleHandleW(None).expect("module handle");
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: w!("KineticProbe"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0), w!("KineticProbe"), w!("probe"), WINDOW_STYLE(0), 0, 0, 0, 0,
            Some(HWND_MESSAGE), None, Some(instance.into()), None,
        )
        .expect("probe window");

        // Whole usage pages: generic desktop, consumer, and the vendor-defined pages.
        let pages: [u16; 6] = [0x0001, 0x000C, 0xFF00, 0xFF01, 0xFF02, 0xFF03];
        let devices: Vec<RAWINPUTDEVICE> = pages
            .iter()
            .map(|&page| RAWINPUTDEVICE {
                usUsagePage: page,
                usUsage: 0,
                dwFlags: RIDEV_PAGEONLY | RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            })
            .collect();
        if let Err(e) = RegisterRawInputDevices(&devices, size_of::<RAWINPUTDEVICE>() as u32) {
            eprintln!("probe: could not register for raw input: {e}");
            return;
        }

        println!("probing {} devices for {seconds}s. Press the button now (Ctrl+C to stop early).", tag);
        let thread = GetCurrentThreadId();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(seconds));
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        });

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    println!("probe finished");
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        report(lparam);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

unsafe fn report(lparam: LPARAM) {
    let handle = HRAWINPUT(lparam.0 as *mut c_void);
    let header = size_of::<RAWINPUTHEADER>() as u32;
    let mut size = 0u32;
    if GetRawInputData(handle, RID_INPUT, None, &mut size, header) != 0 || size == 0 {
        return;
    }
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    if GetRawInputData(handle, RID_INPUT, Some(buf.as_mut_ptr() as *mut c_void), &mut size, header) != size {
        return;
    }
    let raw = &*(buf.as_ptr() as *const RAWINPUT);
    let path = device_path(raw.header.hDevice);
    let vendor = VENDOR.get().map(String::as_str).unwrap_or("VID_1532");
    if !path.to_ascii_uppercase().contains(vendor) {
        return;
    }
    let tag = path.split('#').nth(1).unwrap_or("?").to_string();
    let iface = path.to_ascii_uppercase().find("MI_").map(|i| path[i..i + 5].to_string()).unwrap_or_default();

    let t = raw.header.dwType;
    if t == RIM_TYPEHID.0 {
        let hid = &raw.data.hid;
        let len = (hid.dwSizeHid * hid.dwCount) as usize;
        let bytes = std::slice::from_raw_parts(hid.bRawData.as_ptr(), len);
        if let Ok(mut last) = LAST.lock() {
            if last.as_slice() == bytes {
                return;
            }
            *last = bytes.to_vec();
        }
        println!("HID   {tag} {iface}  {} bytes: {}", len, hex(bytes));
    } else if t == RIM_TYPEKEYBOARD.0 {
        let k = &raw.data.keyboard;
        println!("KEY   {tag} {iface}  vkey=0x{:02x} make=0x{:02x} flags=0x{:x}", k.VKey, k.MakeCode, k.Flags);
    } else if t == RIM_TYPEMOUSE.0 {
        let m = &raw.data.mouse;
        let f = m.Anonymous.Anonymous.usButtonFlags;
        if f != 0 {
            println!("MOUSE {tag} {iface}  buttonFlags=0x{:04x} data=0x{:04x}", f, m.Anonymous.Anonymous.usButtonData);
        }
    }
}
