//! A device report: what the engine can see about each connected mouse, for support requests.
//! It holds hardware identifiers and HID layout only. No keystrokes, paths or account data.

use serde_json::{json, Value};

use crate::{bus, config, input};

/// Collect the report and publish it as a `report` event.
pub fn publish() {
    bus::publish(&build());
}

fn build() -> Value {
    let mice = input::devices_event();
    let mice: Vec<Value> = mice.get("devices").and_then(Value::as_array).cloned().unwrap_or_default();
    let cfg = config::current();
    let api = hidapi::HidApi::new().ok();

    let devices: Vec<Value> = mice
        .iter()
        .map(|m| {
            let vid = m.get("vid").and_then(Value::as_u64).unwrap_or(0) as u16;
            let pid = m.get("pid").and_then(Value::as_u64).unwrap_or(0) as u16;
            let interfaces: Vec<Value> = api
                .as_ref()
                .map(|a| {
                    a.device_list()
                        .filter(|d| d.vendor_id() == vid && d.product_id() == pid)
                        .map(|d| {
                            json!({
                                "interface": d.interface_number(),
                                "usage_page": format!("0x{:04X}", d.usage_page()),
                                "usage": format!("0x{:04X}", d.usage()),
                                "product": d.product_string().unwrap_or(""),
                                "manufacturer": d.manufacturer_string().unwrap_or(""),
                                "release": format!("0x{:04X}", d.release_number()),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let learned: Vec<Value> = cfg
                .learned
                .iter()
                .filter(|l| l.vid == vid && l.pid == pid)
                .map(|l| {
                    json!({
                        "button": l.button, "label": l.label, "collection": l.path_contains,
                        "report_id": l.report_id, "byte": l.byte_index,
                        "down": format!("0x{:02X}", l.down_value), "up": format!("0x{:02X}", l.up_value),
                    })
                })
                .collect();
            json!({
                "vid": format!("0x{vid:04X}"), "pid": format!("0x{pid:04X}"),
                "name": m.get("name"), "buttons": m.get("buttons"),
                "interfaces": interfaces, "learned_buttons": learned,
            })
        })
        .collect();

    json!({
        "t": "report",
        "engine": env!("CARGO_PKG_VERSION"),
        "windows": std::env::var("OS").unwrap_or_default(),
        "devices": devices,
    })
}
