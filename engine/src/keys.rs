//! Key names used in the config, mapped to Windows virtual-key codes.

/// Returns the virtual-key code and whether the key needs the extended-key flag.
pub fn lookup(name: &str) -> Option<(u16, bool)> {
    let n = name.trim().to_ascii_lowercase();
    let n = n.as_str();

    if n.len() == 1 {
        let c = n.as_bytes()[0];
        if c.is_ascii_lowercase() {
            return Some((c.to_ascii_uppercase() as u16, false));
        }
        if c.is_ascii_digit() {
            return Some((c as u16, false));
        }
    }
    if let Some(rest) = n.strip_prefix('f') {
        if let Ok(num) = rest.parse::<u16>() {
            if (1..=24).contains(&num) {
                return Some((0x6F + num, false));
            }
        }
    }

    Some(match n {
        "ctrl" | "control" => (0x11, false),
        "shift" => (0x10, false),
        "alt" | "menu" => (0x12, false),
        "win" | "meta" | "super" => (0x5B, true),
        "enter" | "return" => (0x0D, false),
        "esc" | "escape" => (0x1B, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, true),
        "insert" | "ins" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        "browserback" => (0xA6, false),
        "browserforward" => (0xA7, false),
        "volumeup" => (0xAF, false),
        "volumedown" => (0xAE, false),
        "volumemute" => (0xAD, false),
        "playpause" => (0xB3, false),
        "nexttrack" => (0xB0, false),
        "prevtrack" => (0xB1, false),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::lookup;

    #[test]
    fn letters_digits_and_function_keys() {
        assert_eq!(lookup("c"), Some((0x43, false)));
        assert_eq!(lookup("C"), Some((0x43, false)));
        assert_eq!(lookup("5"), Some((0x35, false)));
        assert_eq!(lookup("F1"), Some((0x70, false)));
        assert_eq!(lookup("f12"), Some((0x7B, false)));
        assert_eq!(lookup("f25"), None);
    }

    #[test]
    fn named_keys() {
        assert_eq!(lookup("Ctrl"), Some((0x11, false)));
        assert_eq!(lookup("left"), Some((0x25, true)));
        assert_eq!(lookup("nonsense"), None);
    }
}
