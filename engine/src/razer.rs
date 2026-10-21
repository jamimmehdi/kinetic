//! Razer devices: reading and setting the mouse's own DPI and polling rate, and reading the battery,
//! over Razer's HID feature-report protocol (the same private channel Razer's own software uses).
//!
//! A report is 90 bytes: status, transaction id, remaining packets (2), protocol type, data size,
//! command class, command id, 80 argument bytes, a checksum (XOR of bytes 2 to 87) and a spare byte.
//!
//! Everything runs on one worker thread that owns the device. The rest of the engine talks to it
//! through a channel and reads the last known values, so the input hook never waits on USB.

use crate::{bus, movement};
use hidapi::{HidApi, HidDevice};
use serde_json::json;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

pub const RAZER_VID: u16 = 0x1532;

const REPORT_LEN: usize = 90;
/// Transaction ids Razer devices use. Which one a model answers to differs, so each is tried.
const TRANSACTION_IDS: [u8; 4] = [0x1F, 0x3F, 0x2F, 0xFF];
const STATUS_OK: u8 = 0x02;
/// Polling rates the older protocol can set, with the code each uses.
const POLLING_CODES: [(u32, u8); 3] = [(1000, 0x01), (500, 0x02), (125, 0x08)];
const MIN_DPI: u32 = 100;
const MAX_DPI: u32 = 30_000;

// ---- protocol ------------------------------------------------------------------------------------

/// Builds the feature report to send: a leading 0 (HID report id) followed by the 90 bytes.
pub fn build_report(transaction: u8, class: u8, id: u8, args: &[u8]) -> [u8; REPORT_LEN + 1] {
    let mut r = [0u8; REPORT_LEN + 1];
    let b = &mut r[1..];
    b[1] = transaction;
    b[5] = args.len() as u8;
    b[6] = class;
    b[7] = id;
    b[8..8 + args.len()].copy_from_slice(args);
    b[88] = b[2..88].iter().fold(0u8, |acc, x| acc ^ x);
    r
}

/// What a device answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u8,
    pub transaction: u8,
    pub class: u8,
    pub id: u8,
    pub args: Vec<u8>,
}

pub fn parse_reply(raw: &[u8]) -> Option<Reply> {
    // hidapi returns the report id first, then the 90 bytes.
    let b = if raw.len() > REPORT_LEN { &raw[1..=REPORT_LEN] } else if raw.len() == REPORT_LEN { raw } else { return None };
    Some(Reply { status: b[0], transaction: b[1], class: b[6], id: b[7], args: b[8..88].to_vec() })
}

pub fn polling_code(hz: u32) -> Option<u8> {
    POLLING_CODES.iter().find(|(h, _)| *h == hz).map(|(_, c)| *c)
}

pub fn polling_hz(code: u8) -> Option<u32> {
    POLLING_CODES.iter().find(|(_, c)| *c == code).map(|(h, _)| *h)
}

/// Battery level from the raw 0 to 255 reading, as a percentage.
pub fn battery_percent(raw: u8) -> u8 {
    ((raw as u32 * 100 + 127) / 255) as u8
}

struct Device {
    dev: HidDevice,
    transaction: u8,
    pid: u16,
}

impl Device {
    /// Sends one command and reads the reply. Returns None when the device does not answer.
    fn query(&self, class: u8, id: u8, args: &[u8]) -> Option<Reply> {
        let report = build_report(self.transaction, class, id, args);
        // A busy (1) or timed-out (4) reply means "ask again shortly".
        for attempt in 0..4 {
            if self.dev.send_feature_report(&report).is_err() {
                sleep(Duration::from_millis(60));
                continue;
            }
            sleep(Duration::from_millis(if attempt == 0 { 35 } else { 80 }));
            let mut buf = [0u8; REPORT_LEN + 1];
            let Ok(n) = self.dev.get_feature_report(&mut buf) else { continue };
            let Some(r) = parse_reply(&buf[..n]) else { continue };
            if r.class != class || r.id != id {
                continue;
            }
            if r.status == 0x01 || r.status == 0x04 {
                continue;
            }
            return Some(r);
        }
        None
    }

    fn get_dpi(&self) -> Option<(u32, u32)> {
        let r = self.query(0x04, 0x85, &[0x01, 0, 0, 0, 0, 0, 0])?;
        (r.status == STATUS_OK).then(|| {
            (u16::from_be_bytes([r.args[1], r.args[2]]) as u32, u16::from_be_bytes([r.args[3], r.args[4]]) as u32)
        })
    }

    /// Sets the DPI. The store flag 1 is the working value; 0 is accepted but ignored by this mouse.
    fn set_dpi(&self, x: u32, y: u32) -> bool {
        let (x, y) = (x.clamp(MIN_DPI, MAX_DPI) as u16, y.clamp(MIN_DPI, MAX_DPI) as u16);
        let (xb, yb) = (x.to_be_bytes(), y.to_be_bytes());
        self.query(0x04, 0x05, &[0x01, xb[0], xb[1], yb[0], yb[1], 0, 0]).is_some_and(|r| r.status == STATUS_OK)
    }

    fn get_polling(&self) -> Option<u32> {
        let r = self.query(0x00, 0x85, &[0x00])?;
        (r.status == STATUS_OK).then(|| polling_hz(r.args[0])).flatten()
    }

    fn set_polling(&self, hz: u32) -> bool {
        let Some(code) = polling_code(hz) else { return false };
        self.query(0x00, 0x05, &[code]).is_some_and(|r| r.status == STATUS_OK)
    }

    fn get_battery(&self) -> Option<u8> {
        let r = self.query(0x07, 0x80, &[0x00, 0x00])?;
        (r.status == STATUS_OK).then(|| battery_percent(r.args[1]))
    }
}

/// Finds a Razer mouse that answers the DPI question, on the interface Razer's own software uses
/// (the mouse collection of interface 0).
fn connect(api: &HidApi) -> Option<Device> {
    for info in api.device_list() {
        if info.vendor_id() != RAZER_VID || info.interface_number() != 0 || info.usage_page() != 0x01 || info.usage() != 0x02 {
            continue;
        }
        let Ok(dev) = info.open_device(api) else { continue };
        let mut candidate = Device { dev, transaction: 0, pid: info.product_id() };
        for t in TRANSACTION_IDS {
            candidate.transaction = t;
            if candidate.get_dpi().is_some() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---- shared state --------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub connected: bool,
    pub pid: u16,
    pub dpi: Option<(u32, u32)>,
    pub polling: Option<u32>,
    pub battery: Option<u8>,
}

struct Shared {
    snap: Snapshot,
    /// The DPI the mouse had when we first saw it; put back when the engine stops.
    original_dpi: Option<(u32, u32)>,
    /// A DPI we asked for, so a change to it is not mistaken for a press of the mouse's own DPI button.
    expected_dpi: Option<(u32, u32)>,
}

static SHARED: Mutex<Shared> = Mutex::new(Shared { snap: Snapshot { connected: false, pid: 0, dpi: None, polling: None, battery: None }, original_dpi: None, expected_dpi: None });
static RESTORED: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

enum Cmd {
    SetDpi(u32, u32),
    SetPolling(u32),
    Restore,
}

static TX: OnceLock<Sender<Cmd>> = OnceLock::new();

pub fn snapshot() -> Snapshot {
    SHARED.lock().map(|s| s.snap.clone()).unwrap_or_default()
}

pub fn connected() -> bool {
    snapshot().connected
}

/// The mouse's DPI as last read, if a supported mouse is connected.
pub fn hardware_dpi() -> Option<(u32, u32)> {
    let s = snapshot();
    if s.connected {
        s.dpi
    } else {
        None
    }
}

/// Ask the mouse to switch to this DPI. Does nothing when it is already there.
pub fn request_dpi(x: u32, y: u32) {
    let want = (x.clamp(MIN_DPI, MAX_DPI), y.clamp(MIN_DPI, MAX_DPI));
    if hardware_dpi() == Some(want) {
        return;
    }
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cmd::SetDpi(want.0, want.1));
    }
}

pub fn request_polling(hz: u32) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Cmd::SetPolling(hz));
    }
}

pub fn hardware_event() -> serde_json::Value {
    let s = snapshot();
    json!({
        "t": "hardware",
        "vendor": "Razer",
        "connected": s.connected,
        "dpi_x": s.dpi.map(|d| d.0),
        "dpi_y": s.dpi.map(|d| d.1),
        "polling_hz": s.polling,
        "polling_options": POLLING_CODES.iter().map(|(h, _)| *h).collect::<Vec<_>>(),
        "can_set_polling": s.connected && s.polling.is_some(),
        "can_set_dpi": s.connected && s.dpi.is_some(),
        "battery": s.battery,
    })
}

/// Put the mouse back to the DPI it had before the engine changed it. Waits briefly for the worker.
pub fn restore_blocking() {
    let Some(tx) = TX.get() else { return };
    if let Ok(mut done) = RESTORED.0.lock() {
        *done = false;
    }
    if tx.send(Cmd::Restore).is_err() {
        return;
    }
    if let Ok(done) = RESTORED.0.lock() {
        let _ = RESTORED.1.wait_timeout_while(done, Duration::from_millis(600), |d| !*d);
    }
}

// ---- worker --------------------------------------------------------------------------------------

pub fn start() {
    // Tests must never touch the real mouse's settings.
    if crate::hook::test_mode() {
        return;
    }
    let (tx, rx) = channel();
    if TX.set(tx).is_err() {
        return;
    }
    thread::spawn(move || {
        let Ok(mut api) = HidApi::new() else { return };
        let mut device: Option<Device> = None;
        let mut last_try = Instant::now() - Duration::from_secs(10);
        let mut tick = 0u32;

        loop {
            // Commands first; otherwise wake once a second to look at the mouse.
            let cmd = match rx.recv_timeout(Duration::from_millis(1000)) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };

            if device.is_none() {
                if last_try.elapsed() < Duration::from_secs(3) {
                    if matches!(cmd, Some(Cmd::Restore)) {
                        finish_restore();
                    }
                    continue;
                }
                last_try = Instant::now();
                let _ = api.refresh_devices();
                device = connect(&api);
                match &device {
                    Some(d) => {
                        println!("engine: Razer mouse {:04x} connected over HID", d.pid);
                        if let Ok(mut s) = SHARED.lock() {
                            s.snap.connected = true;
                            s.snap.pid = d.pid;
                        }
                        tick = 0;
                    }
                    None => {
                        if matches!(cmd, Some(Cmd::Restore)) {
                            finish_restore();
                        }
                        continue;
                    }
                }
            }
            let Some(d) = device.as_ref() else { continue };

            match cmd {
                Some(Cmd::SetDpi(x, y)) => {
                    if let Ok(mut s) = SHARED.lock() {
                        s.expected_dpi = Some((x, y));
                    }
                    d.set_dpi(x, y);
                }
                Some(Cmd::SetPolling(hz)) => {
                    d.set_polling(hz);
                    tick = 0; // read it back at once
                }
                Some(Cmd::Restore) => {
                    let original = SHARED.lock().ok().and_then(|s| s.original_dpi);
                    if let Some((x, y)) = original {
                        d.set_dpi(x, y);
                    }
                    finish_restore();
                    continue;
                }
                None => {}
            }

            // Read the mouse. A read that fails twice in a row means it went away.
            let dpi = d.get_dpi();
            let polling = if tick % 5 == 0 { d.get_polling() } else { None };
            let battery = if tick % 20 == 0 { d.get_battery() } else { None };
            tick = tick.wrapping_add(1);

            if dpi.is_none() && d.get_dpi().is_none() {
                device = None;
                if let Ok(mut s) = SHARED.lock() {
                    s.snap = Snapshot::default();
                }
                bus::publish(&hardware_event());
                movement::apply_config();
                continue;
            }

            let mut external = None;
            let changed = {
                let Ok(mut s) = SHARED.lock() else { continue };
                let before = s.snap.clone();
                if let Some(now) = dpi {
                    if s.original_dpi.is_none() {
                        s.original_dpi = Some(now);
                    }
                    if before.dpi != Some(now) {
                        // A change we did not ask for is the user pressing the mouse's own DPI button.
                        if s.expected_dpi != Some(now) && before.dpi.is_some() {
                            external = Some(now);
                        }
                        s.snap.dpi = Some(now);
                    }
                }
                if polling.is_some() {
                    s.snap.polling = polling;
                }
                if battery.is_some() {
                    s.snap.battery = battery;
                }
                s.snap != before
            };
            if changed {
                bus::publish(&hardware_event());
                match external {
                    Some((x, y)) => movement::on_hardware_dpi(x, y),
                    None => movement::apply_config(),
                }
            }
        }
    });
}

fn finish_restore() {
    if let Ok(mut done) = RESTORED.0.lock() {
        *done = true;
        RESTORED.1.notify_all();
    }
}

/// Command line probe: `kinetic-engine razer-probe`. Read-only: lists the Razer interfaces and asks
/// each for its DPI, polling rate and battery.
pub fn probe() {
    let api = match HidApi::new() {
        Ok(a) => a,
        Err(e) => {
            println!("could not start HID: {e}");
            return;
        }
    };
    match connect(&api) {
        Some(d) => {
            println!("Razer mouse {:04x}, transaction id 0x{:02x}", d.pid, d.transaction);
            println!("  DPI: {:?}", d.get_dpi());
            println!("  polling rate: {:?}", d.get_polling());
            println!("  battery: {:?}", d.get_battery());
            for store in [0x00u8, 0x01] {
                let dpi = d.query(0x04, 0x85, &[store, 0, 0, 0, 0, 0, 0]).map(|x| (x.status, x.args[..5].to_vec()));
                println!("  DPI with store flag {store}: {dpi:02x?}");
                if let Some(x) = d.query(0x04, 0x86, &[store]) {
                    println!("  stage table (store {store}): status 0x{:02x}, active {:02x}, count {:02x}", x.status, x.args[1], x.args[2]);
                }
            }
            // The mouse may also describe its current state under other commands.
            for (name, class, id, args) in [("device mode", 0x00u8, 0x84u8, vec![0u8, 0]), ("dpi (alt 0x81)", 0x04, 0x81, vec![0]), ("profile", 0x05, 0x80, vec![0])] {
                match d.query(class, id, &args) {
                    Some(x) => println!("  {name}: status 0x{:02x}, {:02x?}", x.status, &x.args[..8]),
                    None => println!("  {name}: no answer"),
                }
            }
        }
        None => println!("no Razer mouse answered"),
    }
}

/// `kinetic-engine razer-test`: changes the DPI and polling rate on the real mouse and puts both back.
pub fn hardware_test() {
    let Ok(api) = HidApi::new() else { return };
    let Some(d) = connect(&api) else {
        println!("no Razer mouse answered");
        return;
    };
    let (Some(dpi0), poll0) = (d.get_dpi(), d.get_polling()) else { return };
    println!("start: DPI {dpi0:?}, polling {poll0:?}, battery {:?}", d.get_battery());
    let target = if dpi0.0 == 1600 { 800 } else { 1600 };
    println!("set DPI {target}: {}", d.set_dpi(target, target));
    sleep(Duration::from_millis(400));
    println!("  read back: {:?}", d.get_dpi());
    println!("restore DPI {dpi0:?}: {}", d.set_dpi(dpi0.0, dpi0.1));
    sleep(Duration::from_millis(400));
    println!("  read back: {:?}", d.get_dpi());
    if let Some(p) = poll0 {
        let other = if p == 500 { 1000 } else { 500 };
        println!("set polling {other}: {}", d.set_polling(other));
        sleep(Duration::from_millis(200));
        println!("  read back: {:?}", d.get_polling());
        println!("restore polling {p}: {}", d.set_polling(p));
        sleep(Duration::from_millis(200));
        println!("  read back: {:?}", d.get_polling());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_layout_and_checksum() {
        let r = build_report(0x1F, 0x04, 0x85, &[0x01]);
        assert_eq!(r.len(), 91);
        assert_eq!(r[0], 0, "HID report id");
        let b = &r[1..];
        // status, transaction, remaining (2), protocol, data size, class, id, arguments
        assert_eq!((b[0], b[1], b[5], b[6], b[7], b[8]), (0, 0x1F, 1, 0x04, 0x85, 0x01));
        assert_eq!(b[88], b[2..88].iter().fold(0u8, |a, x| a ^ x), "checksum is the XOR of bytes 2 to 87");
    }

    #[test]
    fn parses_a_reply() {
        let mut raw = [0u8; 91];
        raw[1] = STATUS_OK;
        raw[2] = 0x1F;
        raw[7] = 0x04;
        raw[8] = 0x85;
        raw[9] = 0x01;
        raw[10] = 0x04;
        raw[11] = 0xB0; // 1200
        raw[12] = 0x04;
        raw[13] = 0xB0;
        let r = parse_reply(&raw).unwrap();
        assert_eq!((r.status, r.transaction, r.class, r.id), (STATUS_OK, 0x1F, 0x04, 0x85));
        assert_eq!(u16::from_be_bytes([r.args[1], r.args[2]]), 1200);
        assert!(parse_reply(&[0u8; 10]).is_none());
    }

    #[test]
    fn set_dpi_report_carries_both_axes() {
        let r = build_report(0x1F, 0x04, 0x05, &[0x01, 0x06, 0x40, 0x04, 0xB0, 0, 0]);
        assert_eq!(&r[1..][8..13], &[0x01, 0x06, 0x40, 0x04, 0xB0]);
        assert_eq!(r[1..][5], 7, "seven argument bytes");
    }

    #[test]
    fn polling_codes_round_trip() {
        assert_eq!(polling_code(1000), Some(1));
        assert_eq!(polling_code(500), Some(2));
        assert_eq!(polling_code(125), Some(8));
        assert_eq!(polling_code(250), None);
        assert_eq!(polling_hz(1), Some(1000));
        assert_eq!(polling_hz(9), None);
    }

    #[test]
    fn battery_is_a_percentage() {
        assert_eq!(battery_percent(0), 0);
        assert_eq!(battery_percent(255), 100);
        assert_eq!(battery_percent(174), 68);
    }
}
