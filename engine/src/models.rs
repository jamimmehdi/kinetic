//! Buttons Windows does not report, found in a mouse's own HID reports. Built-in knowledge of
//! specific models lives in `EXTRA_BUTTONS`; buttons the user teaches the app are stored in the
//! config (`learned`) and decoded the same way.

use crate::config::{self, LearnedButton};

pub struct ExtraButton {
    pub vid: u16,
    pub pid: u16,
    /// Button number shown in the UI (6 and up).
    pub button: u8,
    /// Part of the HID interface path that picks the right collection (upper case).
    pub path_contains: &'static str,
    pub report_id: u8,
    pub byte_index: usize,
    pub down_value: u8,
    pub up_value: u8,
    pub label: &'static str,
}

pub const EXTRA_BUTTONS: &[ExtraButton] = &[
    // Razer, found with `kinetic-engine probe`: the top button sends report 4 with 0x52 on
    // collection 5 of interface 1. Release is the same report with 0.
    ExtraButton {
        vid: 0x1532,
        pid: 0x0094,
        button: 6,
        path_contains: "COL05",
        report_id: 0x04,
        byte_index: 1,
        down_value: 0x52,
        up_value: 0,
        label: "Top button",
    },
];

/// "\\?\HID#VID_1532&PID_0094&MI_01&Col05#..." gives (0x1532, 0x0094).
pub fn vid_pid(path: &str) -> Option<(u16, u16)> {
    let upper = path.to_ascii_uppercase();
    let field = |tag: &str| {
        let i = upper.find(tag)? + tag.len();
        u16::from_str_radix(upper.get(i..i + 4)?, 16).ok()
    };
    Some((field("VID_")?, field("PID_")?))
}

/// The part of a HID path that tells collections of one interface apart: `COL05`, else `MI_01`.
pub fn collection_tag(path: &str) -> String {
    let upper = path.to_ascii_uppercase();
    for tag in ["COL", "MI_"] {
        if let Some(i) = upper.find(tag) {
            if let Some(s) = upper.get(i..i + 5) {
                return s.to_string();
            }
        }
    }
    String::new()
}

pub enum Change {
    Down(u8),
    Up(u8),
}

struct Def<'a> {
    vid: u16,
    pid: u16,
    button: u8,
    path_contains: &'a str,
    report_id: u8,
    byte_index: usize,
    down_value: u8,
    up_value: u8,
}

fn built_in<'a>() -> impl Iterator<Item = Def<'a>> {
    EXTRA_BUTTONS.iter().map(|e| Def {
        vid: e.vid,
        pid: e.pid,
        button: e.button,
        path_contains: e.path_contains,
        report_id: e.report_id,
        byte_index: e.byte_index,
        down_value: e.down_value,
        up_value: e.up_value,
    })
}

fn learned(l: &LearnedButton) -> Def<'_> {
    Def {
        vid: l.vid,
        pid: l.pid,
        button: l.button,
        path_contains: &l.path_contains,
        report_id: l.report_id,
        byte_index: l.byte_index,
        down_value: l.down_value,
        up_value: l.up_value,
    }
}

fn decode_with<'a>(defs: impl Iterator<Item = Def<'a>>, extra: &'a [LearnedButton], path: &str, report: &[u8]) -> Option<Change> {
    let (vid, pid) = vid_pid(path)?;
    let upper = path.to_ascii_uppercase();
    let all = defs.chain(extra.iter().map(learned));
    for d in all {
        if d.vid != vid || d.pid != pid || !(d.path_contains.is_empty() || upper.contains(d.path_contains)) {
            continue;
        }
        if report.len() <= d.byte_index || report[0] != d.report_id {
            continue;
        }
        let v = report[d.byte_index];
        if v == d.down_value {
            return Some(Change::Down(d.button));
        }
        if v == d.up_value {
            return Some(Change::Up(d.button));
        }
    }
    None
}

/// Interprets one raw HID report from `path`. Returns the extra-button change it carries, if any.
pub fn decode(path: &str, report: &[u8]) -> Option<Change> {
    let cfg = config::shared().read().ok()?;
    decode_with(built_in(), &cfg.learned, path, report)
}

/// Extra buttons known for a device, for the UI: (button, label).
pub fn extras_for(vid: u16, pid: u16, learned_list: &[LearnedButton]) -> Vec<(u8, String)> {
    let mut out: Vec<(u8, String)> = EXTRA_BUTTONS
        .iter()
        .filter(|e| e.vid == vid && e.pid == pid)
        .map(|e| (e.button, e.label.to_string()))
        .collect();
    for l in learned_list.iter().filter(|l| l.vid == vid && l.pid == pid) {
        if !out.iter().any(|(b, _)| *b == l.button) {
            out.push((l.button, l.label.clone()));
        }
    }
    out
}

/// True when a built-in or already learned button uses this same signal.
pub fn is_known(l: &LearnedButton, learned_list: &[LearnedButton]) -> bool {
    let builtin = EXTRA_BUTTONS.iter().any(|e| {
        e.vid == l.vid
            && e.pid == l.pid
            && e.path_contains.eq_ignore_ascii_case(&l.path_contains)
            && e.report_id == l.report_id
            && e.byte_index == l.byte_index
            && e.down_value == l.down_value
    });
    builtin
        || learned_list.iter().any(|k| {
            (k.vid, k.pid, &k.path_contains, k.report_id, k.byte_index, k.down_value)
                == (l.vid, l.pid, &l.path_contains, l.report_id, l.byte_index, l.down_value)
        })
}

/// Lowest button number from 6 up that no built-in or learned button uses for this device.
pub fn next_button(vid: u16, pid: u16, learned_list: &[LearnedButton]) -> u8 {
    let used = extras_for(vid, pid, learned_list);
    (6..=16).find(|n| !used.iter().any(|(b, _)| b == n)).unwrap_or(16)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = r"\\?\HID#VID_1532&PID_0094&MI_01&Col05#8&1a2b&0&0004#{4d1e55b2}";

    fn decode_builtin(path: &str, report: &[u8]) -> Option<Change> {
        decode_with(built_in(), &[], path, report)
    }

    fn report(id: u8, value: u8) -> [u8; 16] {
        let mut r = [0u8; 16];
        r[0] = id;
        r[1] = value;
        r
    }

    #[test]
    fn parses_vendor_and_product() {
        assert_eq!(vid_pid(PATH), Some((0x1532, 0x0094)));
        assert_eq!(vid_pid(r"\\?\ACPI#PNP0F13"), None);
        assert_eq!(collection_tag(PATH), "COL05");
        assert_eq!(collection_tag(r"\\?\HID#VID_1532&PID_0094&MI_02#x"), "MI_02");
    }

    #[test]
    fn decodes_press_and_release() {
        assert!(matches!(decode_builtin(PATH, &report(4, 0x52)), Some(Change::Down(6))));
        assert!(matches!(decode_builtin(PATH, &report(4, 0)), Some(Change::Up(6))));
    }

    #[test]
    fn ignores_other_reports_and_devices() {
        assert!(decode_builtin(PATH, &report(5, 0x31)).is_none());
        assert!(decode_builtin(r"\\?\HID#VID_046D&PID_C52B&Col05#x", &report(4, 0x52)).is_none());
        assert!(decode_builtin(PATH, &[4]).is_none());
        assert!(decode_builtin(PATH, &report(4, 0x07)).is_none());
    }

    #[test]
    fn learned_buttons_decode_like_built_in_ones() {
        let l = LearnedButton {
            vid: 0x046D,
            pid: 0xC52B,
            path_contains: "COL02".into(),
            report_id: 0x10,
            byte_index: 2,
            down_value: 0x80,
            up_value: 0x00,
            button: 7,
            label: "Gesture".into(),
        };
        let path = r"\\?\HID#VID_046D&PID_C52B&MI_01&Col02#x";
        let mut down = [0u8; 8];
        down[0] = 0x10;
        down[2] = 0x80;
        let mut up = [0u8; 8];
        up[0] = 0x10;
        assert!(matches!(decode_with(built_in(), std::slice::from_ref(&l), path, &down), Some(Change::Down(7))));
        assert!(matches!(decode_with(built_in(), std::slice::from_ref(&l), path, &up), Some(Change::Up(7))));
        // The same report from a different collection is not this button.
        assert!(decode_with(built_in(), std::slice::from_ref(&l), r"\\?\HID#VID_046D&PID_C52B&MI_01&Col03#x", &down).is_none());
    }

    #[test]
    fn knows_its_own_signals() {
        let razer_top = LearnedButton { vid: 0x1532, pid: 0x0094, path_contains: "COL05".into(), report_id: 4, byte_index: 1, down_value: 0x52, up_value: 0, button: 0, label: String::new() };
        assert!(is_known(&razer_top, &[]), "the built-in Razer button");
        let mut other = razer_top.clone();
        other.report_id = 9;
        assert!(!is_known(&other, &[]));
        assert!(is_known(&other, std::slice::from_ref(&other)), "a learned button");
    }

    #[test]
    fn next_free_button_number() {
        assert_eq!(next_button(0x1532, 0x0094, &[]), 7, "6 is built in for this model");
        assert_eq!(next_button(0x046D, 0xC52B, &[]), 6);
        assert_eq!(extras_for(0x1532, 0x0094, &[]), vec![(6, "Top button".to_string())]);
    }
}
