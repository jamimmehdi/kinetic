//! Kinetic engine entry point.
//!
//! The engine owns everything time-critical (input hook, Raw Input, injection) in its own process,
//! so a busy or closed UI can never make the system's mouse stutter.

mod accel;
mod activity;
mod bus;
mod config;
mod foreground;
mod hook;
mod input;
mod keys;
mod learn;
mod macros;
mod measure;
mod models;
mod movement;
mod pipe;
mod probe;
mod razer;
mod report;
mod scroll;
mod spi;
mod state;

use windows::core::BOOL;
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG};

/// Ctrl+C, closing the console or logging off: put the user's pointer settings back first.
unsafe extern "system" fn on_exit(_kind: u32) -> BOOL {
    razer::restore_blocking();
    spi::restore_all();
    BOOL(0)
}

fn main() {
    // `kinetic-engine probe [seconds] [vendor id]` dumps raw reports instead of running the engine.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("razer-test") {
        razer::hardware_test();
        return;
    }
    if args.get(1).map(String::as_str) == Some("razer-probe") {
        razer::probe();
        return;
    }
    if args.get(1).map(String::as_str) == Some("probe") {
        let seconds = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);
        let vendor = args.get(3).map(String::as_str).unwrap_or("1532");
        probe::run(seconds, vendor);
        return;
    }

    // Load the saved mappings before the hook can fire.
    let loaded = config::current();
    println!(
        "kinetic-engine {} starting, {} profile(s), {} macro(s)",
        env!("CARGO_PKG_VERSION"),
        loaded.profiles.len(),
        loaded.macros.len()
    );

    // A previous run that died may have left pointer settings changed.
    spi::recover();
    unsafe {
        let _ = SetConsoleCtrlHandler(Some(on_exit), true);
    }
    macros::start();
    scroll::start();
    razer::start();
    movement::start_telemetry();
    std::thread::spawn(pipe::serve);

    if let Err(e) = input::create_window() {
        eprintln!("engine: Raw Input window failed: {e}");
        std::process::exit(1);
    }
    foreground::install();
    movement::on_profile_changed();
    // The hook lives as long as this thread keeps pumping messages.
    let _hook = match hook::install() {
        Ok(h) => Some(h),
        Err(e) => {
            eprintln!("engine: mouse hook failed, remapping disabled: {e}");
            None
        }
    };

    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
