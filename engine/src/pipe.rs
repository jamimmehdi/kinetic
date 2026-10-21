//! Named-pipe server for the UI. One JSON object per line in both directions.
//!
//! Each client is served by a single thread that alternates between writing queued events and
//! polling for incoming commands. Two threads on one synchronous pipe handle would deadlock,
//! because a pending read blocks writes on the same handle.

use crate::{bus, config, foreground, input, kernel, learn, macros, measure, movement, razer, report, state};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::sync::mpsc::RecvTimeoutError;
use std::thread;
use std::time::Duration;
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PeekNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_LINE: usize = 64 * 1024;
const POLL: Duration = Duration::from_millis(8);

pub fn serve() {
    loop {
        let handle = unsafe {
            CreateNamedPipeW(
                w!(r"\\.\pipe\kinetic-engine"),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                None,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            eprintln!("pipe: could not create the named pipe, retrying");
            thread::sleep(Duration::from_secs(2));
            continue;
        }
        let connected = unsafe { ConnectNamedPipe(handle, None).is_ok() || GetLastError() == ERROR_PIPE_CONNECTED };
        if !connected {
            drop(unsafe { File::from_raw_handle(handle.0) });
            continue;
        }
        // HANDLE is a raw pointer and not Send; the address itself moves freely.
        let raw = handle.0 as usize;
        thread::spawn(move || client(HANDLE(raw as *mut c_void)));
    }
}

fn client(handle: HANDLE) {
    // The File owns the handle and closes it when this thread ends.
    let mut file = unsafe { File::from_raw_handle(handle.0) };
    let rx = bus::subscribe();

    let greeting = [
        json!({ "t": "hello", "version": VERSION }),
        input::devices_event(),
        json!({ "t": "config", "config": config::current() }),
        foreground::active_event(),
        state::event(),
        state::layer_event(),
        movement::dpi_event(),
        razer::hardware_event(),
    ];
    for msg in &greeting {
        if write_line(&mut file, msg).is_err() {
            return;
        }
    }

    let mut pending = Vec::<u8>::new();
    let mut chunk = [0u8; 4096];
    loop {
        match rx.recv_timeout(POLL) {
            Ok(line) => {
                if file.write_all(line.as_bytes()).is_err() {
                    return;
                }
                // Flush anything else already queued before going back to listening.
                while let Ok(more) = rx.try_recv() {
                    if file.write_all(more.as_bytes()).is_err() {
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }

        let mut available = 0u32;
        if unsafe { PeekNamedPipe(handle, None, 0, None, Some(&mut available), None) }.is_err() {
            return; // client went away
        }
        if available > 0 {
            let want = (available as usize).min(chunk.len());
            match file.read(&mut chunk[..want]) {
                Ok(0) | Err(_) => return,
                Ok(n) => pending.extend_from_slice(&chunk[..n]),
            }
            while let Some(nl) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=nl).collect();
                if let Ok(text) = std::str::from_utf8(&line) {
                    handle_command(text.trim());
                }
            }
            if pending.len() > MAX_LINE {
                return; // a client that never sends a newline is misbehaving
            }
        }
    }
}

fn write_line(file: &mut File, value: &Value) -> std::io::Result<()> {
    let mut line = value.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
}

fn handle_command(text: &str) {
    if text.is_empty() {
        return;
    }
    let Ok(cmd) = serde_json::from_str::<Value>(text) else { return };
    match cmd.get("cmd").and_then(Value::as_str) {
        Some("list_devices") => input::publish_devices(),
        Some("snapshot") => {
            // Everything a window that just (re)loaded needs, in one go.
            bus::publish(&json!({ "t": "hello", "version": VERSION }));
            input::publish_devices();
            bus::publish(&json!({ "t": "config", "config": config::current() }));
            bus::publish(&foreground::active_event());
            bus::publish(&state::event());
            bus::publish(&state::layer_event());
            bus::publish(&movement::dpi_event());
            bus::publish(&razer::hardware_event());
            bus::publish(&kernel::status_event());
        }
        Some("get_config") => bus::publish(&json!({ "t": "config", "config": config::current() })),
        Some("set_config") => {
            if let Some(raw) = cmd.get("config") {
                if let Ok(parsed) = serde_json::from_value::<config::Config>(raw.clone()) {
                    let applied = config::replace(parsed);
                    bus::publish(&json!({ "t": "config", "config": applied }));
                    // Profiles may have changed which one the front app should use.
                    foreground::refresh();
                    movement::on_config_replaced();
                }
            }
        }
        Some("list_apps") => bus::publish(&json!({ "t": "apps", "apps": foreground::list_apps() })),
        Some("run_macro") => {
            if let Some(id) = cmd.get("id").and_then(Value::as_str) {
                macros::run_once(id);
            }
        }
        Some("stop_macros") => macros::stop_all(),
        // The tray's Quit item: put the pointer settings back and stop.
        Some("quit") => {
            razer::restore_blocking();
            kernel::restore_blocking();
            crate::spi::restore_all();
            std::process::exit(0);
        }
        Some("set_paused") => state::set_paused(cmd.get("paused").and_then(Value::as_bool).unwrap_or(false)),
        Some("set_stage") => {
            if let Some(n) = cmd.get("stage").and_then(Value::as_u64) {
                movement::set_stage(n as usize);
            }
        }
        Some("set_polling") => {
            if let Some(hz) = cmd.get("hz").and_then(Value::as_u64) {
                razer::request_polling(hz as u32);
            }
        }
        Some("set_game_guard") => state::set_guard(cmd.get("enabled").and_then(Value::as_bool).unwrap_or(true)),
        Some("tremor_start") => crate::tremor::start(cmd.get("seconds").and_then(Value::as_u64).unwrap_or(10), movement::current_native_dpi()),
        Some("tremor_cancel") => crate::tremor::cancel(),
        Some("set_kernel_mode") => kernel::set_enabled(cmd.get("enabled").and_then(Value::as_bool).unwrap_or(false)),
        Some("kernel_refresh") => kernel::refresh(),
        Some("set_failsafe") => state::set_failsafe(cmd.get("enabled").and_then(Value::as_bool).unwrap_or(true)),
        Some("set_activity_log") => crate::activity::set_enabled(cmd.get("enabled").and_then(Value::as_bool).unwrap_or(false)),
        Some("activity_history") => bus::publish(&crate::activity::history()),
        Some("activity_clear") => crate::activity::clear(),
        Some("device_report") => report::publish(),
        Some("measure_start") => measure::start(cmd.get("cm").and_then(Value::as_f64).unwrap_or(10.0)),
        Some("measure_finish") => measure::finish(),
        Some("measure_cancel") => measure::cancel(),
        Some("learn_start") => learn::start(cmd.get("multi").and_then(Value::as_bool).unwrap_or(false)),
        Some("learn_cancel") => learn::cancel(),
        Some("learn_confirm") => {
            let label = cmd.get("label").and_then(Value::as_str).unwrap_or("");
            let button = cmd.get("button").and_then(Value::as_u64).map(|b| b as u8);
            learn::confirm(label, button);
        }
        _ => {}
    }
}
