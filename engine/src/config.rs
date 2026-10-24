//! Persisted configuration: profiles (button maps, sensitivity, acceleration), macros and learned buttons.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

pub const DEFAULT_PROFILE: &str = "default";
const MAX_EVENTS: usize = 2000;
const MAX_DELAY_MS: u32 = 60_000;
const MAX_LOOPS: u32 = 10_000;
const MAX_ID: usize = 64;
const MAX_NAME: usize = 80;
const MAX_STAGES: usize = 8;
const MAX_POINTS: usize = 32;
const MAX_LEARNED: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// Press these keys together, for example `["ctrl", "c"]`.
    Key { keys: Vec<String> },
    /// Act as another mouse button.
    Mouse { button: MouseButtonName },
    /// Run a macro from the config.
    Macro { id: String },
    /// Change the DPI stage. `op` is cycle, up, down, set (go to `stage`) or hold (use `stage` while held).
    Dpi {
        op: String,
        #[serde(default)]
        stage: usize,
    },
    /// While held, the Shift layer's mappings apply.
    Shift,
    /// Start a program (a path to an executable or document).
    Launch { path: String },
    /// Swallow the button so apps never see it.
    Disabled,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButtonName {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Mapping {
    /// 1 left, 2 right, 3 middle, 4 back (X1), 5 forward (X2), 6 and up are device-specific extras.
    pub button: u8,
    pub action: Action,
}

// ---- sensitivity and acceleration -------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stage {
    /// Horizontal DPI (and vertical too unless `independent_xy` is on).
    pub dpi: u32,
    #[serde(default)]
    pub dpi_y: Option<u32>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccelMode {
    Off,
    Linear,
    Classic,
    Natural,
    Sigmoid,
    Power,
    Jump,
    Custom,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CurveKind {
    /// The curve is the sensitivity multiplier at each speed.
    Sensitivity,
    /// The curve is the gain (slope of output speed over input speed).
    Gain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Accel {
    pub mode: AccelMode,
    pub kind: CurveKind,
    /// How fast the curve rises. Meaning depends on the mode.
    pub rate: f32,
    /// Speed (counts per ms) below which nothing happens.
    pub offset: f32,
    /// Highest multiplier the curve may reach.
    pub limit: f32,
    /// Speed at the middle of a sigmoid or at a jump.
    pub midpoint: f32,
    pub exponent: f32,
    /// Limit the output speed.
    pub speed_cap: bool,
    /// Apply the curve to each axis separately.
    pub per_axis: bool,
    /// Custom curve: (speed, value) points, sorted by speed.
    pub points: Vec<[f32; 2]>,
}

impl Default for Accel {
    fn default() -> Self {
        Accel {
            mode: AccelMode::Off,
            kind: CurveKind::Sensitivity,
            rate: 0.8,
            offset: 0.0,
            limit: 2.5,
            midpoint: 4.0,
            exponent: 2.0,
            speed_cap: false,
            per_axis: false,
            points: vec![[0.0, 1.0], [4.0, 1.5], [8.0, 2.5]],
        }
    }
}

/// Settings that steady a shaky or uneven hand. All of them only reshape the movement the mouse
/// reports, using fixed formulas. None of them looks at the game.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Steady {
    /// Reduce sensitivity for very slow movement, where hand tremor lives.
    pub precision: bool,
    /// Speed (counts per ms) below which the reduction applies. Eases out to normal at this speed.
    pub precision_below: f32,
    /// Sensitivity at a standstill relative to normal, 0.1 to 1.
    pub precision_factor: f32,
    /// 0 to 0.95. Smooths the speed used for acceleration (not the pointer), so jittery speed does
    /// not make the curve jitter.
    pub speed_smoothing: f32,
    /// Highest output speed in counts per ms. 0 means no limit.
    pub speed_limit: f32,
    /// Left sensitivity relative to right.
    pub left_ratio: f32,
    /// Up sensitivity relative to down.
    pub up_ratio: f32,
    /// Degrees from straight horizontal or vertical within which angle snapping straightens a move.
    pub snap_degrees: f32,
}

impl Default for Steady {
    fn default() -> Self {
        Steady {
            precision: false,
            precision_below: 1.0,
            precision_factor: 0.6,
            // What the engine always used before this was a setting.
            speed_smoothing: 0.6,
            speed_limit: 0.0,
            left_ratio: 1.0,
            up_ratio: 1.0,
            snap_degrees: 6.0,
        }
    }
}

impl Steady {
    /// True when any of the settings that change the curve itself is on.
    pub fn shapes_curve(&self) -> bool {
        self.precision || self.speed_limit > 0.0
    }

    /// True when this changes movement compared with plain scaling (apart from the snap window,
    /// which only matters while snapping is on).
    pub fn changes_movement(&self) -> bool {
        self.shapes_curve()
            || (self.left_ratio - 1.0).abs() > 0.001
            || (self.up_ratio - 1.0).abs() > 0.001
    }

    fn sanitize(&mut self) {
        self.precision_below = finite(self.precision_below, 1.0).clamp(0.1, 16.0);
        self.precision_factor = finite(self.precision_factor, 0.6).clamp(0.1, 1.0);
        self.speed_smoothing = finite(self.speed_smoothing, 0.6).clamp(0.0, 0.95);
        let limit = finite(self.speed_limit, 0.0);
        self.speed_limit = if limit <= 0.0 { 0.0 } else { limit.clamp(2.0, 64.0) };
        self.left_ratio = finite(self.left_ratio, 1.0).clamp(0.25, 4.0);
        self.up_ratio = finite(self.up_ratio, 1.0).clamp(0.25, 4.0);
        self.snap_degrees = finite(self.snap_degrees, 6.0).clamp(1.0, 45.0);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Scroll {
    /// Lines per wheel notch, applied through the Windows setting while this profile is active.
    pub lines: u32,
    pub smooth: bool,
    pub reverse: bool,
}

impl Default for Scroll {
    fn default() -> Self {
        Scroll { lines: 3, smooth: false, reverse: false }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Perf {
    /// What the mouse's own DPI is set to. Software sensitivity is the stage DPI over this.
    pub native_dpi: u32,
    pub stages: Vec<Stage>,
    pub active_stage: usize,
    pub independent_xy: bool,
    pub accel: Accel,
    /// Degrees. Positive turns movement clockwise.
    pub rotation: f32,
    /// Vertical over horizontal sensitivity.
    pub y_ratio: f32,
    pub angle_snap: bool,
    /// 0 to 0.95. Higher smooths more and adds a little delay.
    pub smoothing: f32,
    /// Turn off Windows pointer acceleration while movement is processed.
    pub raw_movement: bool,
    pub scroll: Scroll,
    /// With a supported mouse, set the mouse's own DPI to the stage instead of scaling in software.
    pub use_hardware: bool,
    /// Settings for a shaky or uneven hand.
    pub steady: Steady,
}

impl Default for Perf {
    fn default() -> Self {
        Perf {
            native_dpi: 1600,
            // Ascending, in steps of 400 up to 1600, then bigger steps.
            stages: [400, 800, 1200, 1600, 2400, 3200].iter().map(|&dpi| Stage { dpi, dpi_y: None }).collect(),
            active_stage: 3,
            independent_xy: false,
            accel: Accel::default(),
            rotation: 0.0,
            y_ratio: 1.0,
            angle_snap: false,
            smoothing: 0.0,
            raw_movement: true,
            scroll: Scroll::default(),
            use_hardware: true,
            steady: Steady::default(),
        }
    }
}

impl Perf {
    /// Horizontal and vertical DPI of a stage.
    pub fn stage_dpi(&self, stage: usize) -> (u32, u32) {
        let s = self.stages.get(stage).or_else(|| self.stages.first());
        match s {
            Some(s) => (s.dpi, if self.independent_xy { s.dpi_y.unwrap_or(s.dpi) } else { s.dpi }),
            None => (self.native_dpi, self.native_dpi),
        }
    }

    /// True when movement must be processed in software while `stage` is in use. With defaults
    /// the mouse moves natively.
    #[cfg(test)]
    pub fn needs_movement(&self, stage: usize) -> bool {
        self.needs_movement_for(self.stage_dpi(stage), self.native_dpi)
    }

    /// Same, for an explicit target DPI and the DPI the mouse really runs at.
    pub fn needs_movement_for(&self, (dx, dy): (u32, u32), native: u32) -> bool {
        dx != native
            || dy != native
            || self.accel.mode != AccelMode::Off
            || self.rotation.abs() > 0.01
            || (self.y_ratio - 1.0).abs() > 0.001
            || self.angle_snap
            || self.smoothing > 0.001
            || self.steady.changes_movement()
    }

    /// Clamps every value, keeps the stages in ascending DPI order and returns where each old stage
    /// index ended up, so anything that points at a stage can follow it.
    fn sanitize(&mut self) -> Vec<usize> {
        self.native_dpi = self.native_dpi.clamp(50, 32_000);
        self.stages.truncate(MAX_STAGES);
        for s in &mut self.stages {
            s.dpi = s.dpi.clamp(50, 32_000);
            s.dpi_y = s.dpi_y.map(|d| d.clamp(50, 32_000));
        }
        if self.stages.is_empty() {
            self.stages = Perf::default().stages;
            self.active_stage = Perf::default().active_stage;
        }
        let mut order: Vec<usize> = (0..self.stages.len()).collect();
        order.sort_by_key(|&i| self.stages[i].dpi); // stable: equal DPIs keep their order
        let mut moved = vec![0usize; order.len()];
        for (new, &old) in order.iter().enumerate() {
            moved[old] = new;
        }
        self.stages = order.iter().map(|&i| self.stages[i].clone()).collect();
        self.active_stage = moved[self.active_stage.min(moved.len() - 1)];
        self.rotation = finite(self.rotation, 0.0).clamp(-180.0, 180.0);
        self.y_ratio = finite(self.y_ratio, 1.0).clamp(0.25, 4.0);
        self.smoothing = finite(self.smoothing, 0.0).clamp(0.0, 0.98);
        self.scroll.lines = self.scroll.lines.clamp(1, 100);
        self.steady.sanitize();

        let a = &mut self.accel;
        a.rate = finite(a.rate, 0.8).clamp(0.0, 20.0);
        a.offset = finite(a.offset, 0.0).clamp(0.0, 20.0);
        a.limit = finite(a.limit, 2.5).clamp(1.0, 20.0);
        a.midpoint = finite(a.midpoint, 4.0).clamp(0.0, 20.0);
        a.exponent = finite(a.exponent, 2.0).clamp(0.1, 6.0);
        a.points.truncate(MAX_POINTS);
        for p in &mut a.points {
            p[0] = finite(p[0], 0.0).clamp(0.0, 32.0);
            p[1] = finite(p[1], 1.0).clamp(0.0, 20.0);
        }
        a.points.sort_by(|x, y| x[0].total_cmp(&y[0]));
        if a.points.len() < 2 {
            a.points = Accel::default().points;
        }
        moved
    }
}

fn finite(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        fallback
    }
}

// ---- profiles, macros, learned buttons ---------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Executable file name (for example `valorant.exe`) that switches to this profile. Lower case.
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub mappings: Vec<Mapping>,
    /// Used instead of `mappings` while a Shift button is held.
    #[serde(default)]
    pub shift_mappings: Vec<Mapping>,
    #[serde(default)]
    pub perf: Perf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Repeat {
    /// Run once per press.
    Once,
    /// Repeat while the button is held.
    Held,
    /// First press starts looping, the next stops it.
    Toggle,
    /// Run this many times.
    Loop { count: u32 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MacroEvent {
    KeyDown { key: String },
    KeyUp { key: String },
    MouseDown { button: MouseButtonName },
    MouseUp { button: MouseButtonName },
    Delay { ms: u32 },
    /// Relative pointer movement.
    Move { dx: i32, dy: i32 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MacroDef {
    pub id: String,
    pub name: String,
    pub repeat: Repeat,
    pub events: Vec<MacroEvent>,
}

/// A button the user taught the app with "press a button to detect": where it hides in a HID report.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LearnedButton {
    pub vid: u16,
    pub pid: u16,
    /// Upper-case part of the HID interface path that picks the collection, for example `COL05`.
    pub path_contains: String,
    pub report_id: u8,
    pub byte_index: usize,
    pub down_value: u8,
    pub up_value: u8,
    /// Button number shown in the UI, 6 or higher.
    pub button: u8,
    pub label: String,
}

/// An app whose sessions Kinetic keeps a record of, for example a game.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tracked {
    /// Executable file name, lower case, for example `valorant-win64-shipping.exe`.
    pub exe: String,
    /// Name shown in the dashboard.
    #[serde(default)]
    pub name: String,
}

/// Most apps that can be tracked at once.
const MAX_TRACKED: usize = 12;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Config {
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub macros: Vec<MacroDef>,
    #[serde(default)]
    pub learned: Vec<LearnedButton>,
    /// Switch profiles by the app in front. When off, only the Default profile is used.
    #[serde(default = "yes")]
    pub auto_switch: bool,
    /// Version 1 stored a single list of mappings here. Read once to migrate, never written.
    #[serde(default, skip_serializing)]
    pub mappings: Vec<Mapping>,
    /// Apps to keep session records for.
    #[serde(default)]
    pub tracked: Vec<Tracked>,
}

fn yes() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Config {
            profiles: vec![default_profile()],
            macros: Vec::new(),
            learned: Vec::new(),
            auto_switch: true,
            mappings: Vec::new(),
            tracked: Vec::new(),
        }
    }
}

fn default_profile() -> Profile {
    Profile {
        id: DEFAULT_PROFILE.into(),
        name: "Default".into(),
        app: None,
        mappings: Vec::new(),
        shift_mappings: Vec::new(),
        perf: Perf::default(),
    }
}

fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

fn sanitize_mappings(list: Vec<Mapping>, macro_ids: &HashSet<String>, moved: &[usize]) -> Vec<Mapping> {
    let stages = moved.len();
    let mut seen = [false; 17];
    let mut out = Vec::new();
    for mut m in list {
        // Button 1 (left click) is never remappable: a bad mapping could lock the user out.
        if !(2..=16).contains(&m.button) || std::mem::replace(&mut seen[m.button as usize], true) {
            continue;
        }
        match &mut m.action {
            Action::Key { keys } => {
                keys.truncate(6);
                if keys.is_empty() {
                    continue;
                }
            }
            Action::Macro { id } if !macro_ids.contains(id) => continue,
            Action::Launch { path } => {
                *path = clean_text(path, 260);
                if path.is_empty() {
                    continue;
                }
            }
            Action::Dpi { op, stage } => {
                if !["cycle", "up", "down", "set", "hold"].contains(&op.as_str()) {
                    continue;
                }
                // Follow the stage if the list was re-sorted; an out-of-range stage means the last one.
                *stage = moved.get(*stage).copied().unwrap_or(stages.saturating_sub(1));
            }
            _ => {}
        }
        out.push(m);
    }
    out
}

impl Config {
    /// Drop or repair anything the engine cannot act on, so a bad file or a bad client message is harmless.
    pub fn sanitized(mut self) -> Self {
        // Version 1 files: their mappings become the default profile.
        if self.profiles.is_empty() && !self.mappings.is_empty() {
            let mut p = default_profile();
            p.mappings = std::mem::take(&mut self.mappings);
            self.profiles.push(p);
        }
        self.mappings.clear();

        // Macros first, because mappings may point at them.
        let mut macro_ids = HashSet::new();
        let mut macros = Vec::new();
        for mut m in std::mem::take(&mut self.macros) {
            m.id = clean_text(&m.id, MAX_ID);
            m.name = clean_text(&m.name, MAX_NAME);
            if m.id.is_empty() || !macro_ids.insert(m.id.clone()) {
                continue;
            }
            if let Repeat::Loop { count } = &mut m.repeat {
                *count = (*count).clamp(1, MAX_LOOPS);
            }
            m.events.truncate(MAX_EVENTS);
            for e in &mut m.events {
                if let MacroEvent::Delay { ms } = e {
                    *ms = (*ms).min(MAX_DELAY_MS);
                }
            }
            macros.push(m);
        }
        self.macros = macros;

        let mut ids = HashSet::new();
        let mut profiles = Vec::new();
        for mut p in std::mem::take(&mut self.profiles) {
            p.id = clean_text(&p.id, MAX_ID);
            p.name = clean_text(&p.name, MAX_NAME);
            p.app = p.app.as_deref().map(|a| clean_text(a, 120).to_ascii_lowercase()).filter(|a| !a.is_empty());
            if p.id.is_empty() || !ids.insert(p.id.clone()) {
                continue;
            }
            if p.id == DEFAULT_PROFILE {
                p.app = None;
            }
            let moved = p.perf.sanitize();
            p.mappings = sanitize_mappings(p.mappings, &macro_ids, &moved);
            p.shift_mappings = sanitize_mappings(p.shift_mappings, &macro_ids, &moved);
            // A Shift button inside the Shift layer would be meaningless.
            p.shift_mappings.retain(|m| m.action != Action::Shift);
            profiles.push(p);
        }
        // The default profile always exists and always comes first.
        match profiles.iter().position(|p| p.id == DEFAULT_PROFILE) {
            Some(0) => {}
            Some(i) => {
                let d = profiles.remove(i);
                profiles.insert(0, d);
            }
            None => profiles.insert(0, default_profile()),
        }
        self.profiles = profiles;

        let mut seen = HashSet::new();
        let mut tracked = Vec::new();
        for mut a in std::mem::take(&mut self.tracked) {
            a.exe = clean_text(&a.exe, 120).to_ascii_lowercase();
            a.name = clean_text(&a.name, 40);
            if a.exe.is_empty() || !seen.insert(a.exe.clone()) {
                continue;
            }
            if a.name.is_empty() {
                a.name = a.exe.trim_end_matches(".exe").to_string();
            }
            tracked.push(a);
        }
        tracked.truncate(MAX_TRACKED);
        self.tracked = tracked;

        self.learned.truncate(MAX_LEARNED);
        for l in &mut self.learned {
            l.path_contains = clean_text(&l.path_contains, 24).to_ascii_uppercase();
            l.label = clean_text(&l.label, MAX_NAME);
            l.button = l.button.clamp(6, 16);
        }
        self
    }

    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Profile that should be active for this foreground executable name (lower case).
    pub fn profile_for_app(&self, exe: &str) -> &str {
        if !self.auto_switch {
            return DEFAULT_PROFILE;
        }
        self.profiles
            .iter()
            .find(|p| p.app.as_deref() == Some(exe))
            .map(|p| p.id.as_str())
            .unwrap_or(DEFAULT_PROFILE)
    }

    pub fn macro_def(&self, id: &str) -> Option<&MacroDef> {
        self.macros.iter().find(|m| m.id == id)
    }

    /// What `button` does while `active` is the active profile. A profile that does not map the
    /// button falls back to the default profile. With `shift` the Shift layer is used instead.
    pub fn action_for(&self, active: &str, button: u8, shift: bool) -> Option<&Action> {
        let find = |id: &str| {
            let p = self.profile(id)?;
            let list = if shift { &p.shift_mappings } else { &p.mappings };
            list.iter().find(|m| m.button == button).map(|m| &m.action)
        };
        find(active).or_else(|| if active != DEFAULT_PROFILE { find(DEFAULT_PROFILE) } else { None })
    }

    pub fn perf_for(&self, active: &str) -> Perf {
        self.profile(active).or_else(|| self.profile(DEFAULT_PROFILE)).map(|p| p.perf.clone()).unwrap_or_default()
    }
}

fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("Kinetic").join("config.json"))
}

/// Reads a config file, or None when it is missing or cannot be understood.
fn read_config(path: &std::path::Path) -> Option<Config> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Config>(&text) {
        Ok(c) => Some(c.sanitized()),
        Err(e) => {
            eprintln!("config: cannot read {}: {e}", path.display());
            None
        }
    }
}

pub fn load() -> Config {
    let Some(path) = config_path() else { return Config::default() };
    if let Some(c) = read_config(&path) {
        return c;
    }
    if !path.exists() {
        return Config::default();
    }
    // The file is there but unreadable. Keep it for inspection instead of overwriting it with
    // defaults on the next save, and fall back to the last good copy if there is one.
    let _ = std::fs::rename(&path, path.with_file_name("config.broken.json"));
    read_config(&path.with_file_name("config.json.bak")).unwrap_or_default()
}

/// When the settings were last written to disk, in milliseconds since 1970 (0 when never).
static SAVED_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn save(config: &Config) {
    let Some(path) = config_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write beside the target then rename, so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    match serde_json::to_string_pretty(config) {
        Ok(text) => {
            if std::fs::write(&tmp, text).is_ok() {
                // Keep the previous version as a backup, so one bad save can never lose everything.
                if path.exists() {
                    let _ = std::fs::copy(&path, path.with_file_name("config.json.bak"));
                }
                if std::fs::rename(&tmp, &path).is_ok() {
                    SAVED_AT.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
                    crate::bus::publish(&saved_event());
                }
            }
        }
        Err(e) => eprintln!("config: could not serialise: {e}"),
    }
}

/// The `saved` event: where the settings live and when they were last written.
pub fn saved_event() -> serde_json::Value {
    let mut at = SAVED_AT.load(std::sync::atomic::Ordering::Relaxed);
    let path = config_path();
    if at == 0 {
        // Nothing saved this session: use the file's own time.
        at = path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
    }
    serde_json::json!({ "t": "saved", "at": at, "path": path.map(|p| p.display().to_string()) })
}

static SHARED: OnceLock<RwLock<Config>> = OnceLock::new();
static ACTIVE: OnceLock<RwLock<String>> = OnceLock::new();

/// The live config, readable from the input hook without any plumbing.
pub fn shared() -> &'static RwLock<Config> {
    SHARED.get_or_init(|| RwLock::new(load()))
}

fn active_cell() -> &'static RwLock<String> {
    ACTIVE.get_or_init(|| RwLock::new(DEFAULT_PROFILE.to_string()))
}

pub fn current() -> Config {
    shared().read().map(|c| c.clone()).unwrap_or_default()
}

pub fn active_profile() -> String {
    active_cell().read().map(|a| a.clone()).unwrap_or_else(|_| DEFAULT_PROFILE.to_string())
}

pub fn set_active_profile(id: &str) {
    if let Ok(mut a) = active_cell().write() {
        *a = id.to_string();
    }
}

pub fn replace(config: Config) -> Config {
    let clean = config.sanitized();
    if let Ok(mut guard) = shared().write() {
        *guard = clean.clone();
    }
    save(&clean);
    // The active profile may have been deleted or renamed.
    if clean.profile(&active_profile()).is_none() {
        set_active_profile(DEFAULT_PROFILE);
    }
    clean
}

/// The action for a button under the active profile. Never blocks: used from the input hook.
pub fn action_for_active(button: u8, shift: bool) -> Option<Action> {
    let active = active_cell().try_read().ok()?;
    let cfg = shared().try_read().ok()?;
    cfg.action_for(&active, button, shift).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_files_are_told_apart_from_good_ones() {
        let dir = std::env::temp_dir().join(format!("kinetic-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ this is not json").unwrap();
        assert!(read_config(&bad).is_none(), "a damaged file must not pass for an empty config");
        let good = dir.join("good.json");
        std::fs::write(&good, serde_json::to_string(&Config::default()).unwrap()).unwrap();
        assert!(read_config(&good).is_some());
        assert!(read_config(&dir.join("missing.json")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tracked_apps_are_cleaned_and_deduplicated() {
        let mut cfg = Config::default();
        cfg.tracked = vec![
            Tracked { exe: "  Valorant-Win64-Shipping.EXE ".into(), name: "".into() },
            Tracked { exe: "valorant-win64-shipping.exe".into(), name: "again".into() },
            Tracked { exe: "".into(), name: "nothing".into() },
        ];
        let cfg = cfg.sanitized();
        assert_eq!(cfg.tracked.len(), 1);
        assert_eq!(cfg.tracked[0].exe, "valorant-win64-shipping.exe");
        assert_eq!(cfg.tracked[0].name, "valorant-win64-shipping", "an empty name falls back to the file name");
    }

    #[test]
    fn older_configs_without_the_newer_sections_still_load() {
        // A 0.1.x file: a profile whose performance block predates the steady-hand settings.
        let text = r#"{"profiles":[{"id":"default","name":"Default","mappings":[],"shift_mappings":[],"perf":{"native_dpi":800}}],"macros":[],"learned":[]}"#;
        let cfg: Config = serde_json::from_str(text).expect("old file should parse");
        let perf = &cfg.sanitized().profiles[0].perf;
        assert_eq!(perf.native_dpi, 800);
        assert_eq!(perf.steady, Steady::default());
    }

    fn key(button: u8, keys: &[&str]) -> Mapping {
        Mapping { button, action: Action::Key { keys: keys.iter().map(|s| s.to_string()).collect() } }
    }

    fn profile(id: &str, app: Option<&str>, mappings: Vec<Mapping>) -> Profile {
        Profile {
            id: id.into(),
            name: id.into(),
            app: app.map(str::to_string),
            mappings,
            shift_mappings: vec![],
            perf: Perf::default(),
        }
    }

    fn config(profiles: Vec<Profile>, macros: Vec<MacroDef>) -> Config {
        Config { profiles, macros, learned: vec![], auto_switch: true, mappings: vec![], tracked: vec![] }
    }

    #[test]
    fn migrates_version_one_mappings() {
        let cfg: Config = serde_json::from_str(r#"{"mappings":[{"button":4,"action":{"type":"key","keys":["ctrl","c"]}}]}"#).unwrap();
        let cfg = cfg.sanitized();
        assert_eq!(cfg.profiles.len(), 1);
        assert_eq!(cfg.profiles[0].id, DEFAULT_PROFILE);
        assert_eq!(cfg.profiles[0].mappings, vec![key(4, &["ctrl", "c"])]);
        // The legacy list is never written back.
        let written: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        assert!(written.get("mappings").is_none());
    }

    #[test]
    fn loads_version_two_files_without_perf() {
        let cfg: Config = serde_json::from_str(
            r#"{"profiles":[{"id":"default","name":"Default","mappings":[]}],"macros":[]}"#,
        )
        .unwrap();
        let cfg = cfg.sanitized();
        assert_eq!(cfg.profiles[0].perf, Perf::default());
        assert!(cfg.learned.is_empty());
    }

    #[test]
    fn default_profile_always_exists_and_leads() {
        let cfg = config(vec![profile("game", Some("Game.EXE"), vec![])], vec![]).sanitized();
        assert_eq!(cfg.profiles[0].id, DEFAULT_PROFILE);
        assert_eq!(cfg.profiles[1].app.as_deref(), Some("game.exe"));
    }

    #[test]
    fn rejects_left_click_empty_combos_and_unknown_macros() {
        let cfg = config(
            vec![profile(
                DEFAULT_PROFILE,
                None,
                vec![
                    key(1, &["a"]),
                    key(2, &[]),
                    key(3, &["b"]),
                    Mapping { button: 4, action: Action::Macro { id: "nope".into() } },
                    key(3, &["c"]),
                ],
            )],
            vec![],
        )
        .sanitized();
        assert_eq!(cfg.profiles[0].mappings, vec![key(3, &["b"])]);
    }

    #[test]
    fn app_switching_and_fallback() {
        let cfg = config(
            vec![
                profile(DEFAULT_PROFILE, None, vec![key(4, &["x"]), key(5, &["y"])]),
                profile("game", Some("game.exe"), vec![key(4, &["z"])]),
            ],
            vec![],
        )
        .sanitized();
        assert_eq!(cfg.profile_for_app("game.exe"), "game");
        assert_eq!(cfg.profile_for_app("other.exe"), DEFAULT_PROFILE);
        assert_eq!(cfg.action_for("game", 4, false), Some(&Action::Key { keys: vec!["z".into()] }));
        // Button 5 is not mapped in "game", so the default profile's mapping applies.
        assert_eq!(cfg.action_for("game", 5, false), Some(&Action::Key { keys: vec!["y".into()] }));
        assert_eq!(cfg.action_for("game", 2, false), None);
    }

    #[test]
    fn auto_switch_can_be_turned_off() {
        let mut cfg = config(vec![profile("game", Some("game.exe"), vec![])], vec![]).sanitized();
        assert_eq!(cfg.profile_for_app("game.exe"), "game");
        cfg.auto_switch = false;
        assert_eq!(cfg.profile_for_app("game.exe"), DEFAULT_PROFILE);
    }

    #[test]
    fn launch_actions_need_a_path() {
        let cfg = config(
            vec![profile(
                DEFAULT_PROFILE,
                None,
                vec![
                    Mapping { button: 4, action: Action::Launch { path: "  ".into() } },
                    Mapping { button: 5, action: Action::Launch { path: "C:\\Windows\\notepad.exe".into() } },
                ],
            )],
            vec![],
        )
        .sanitized();
        assert_eq!(cfg.profiles[0].mappings.len(), 1);
        assert_eq!(cfg.profiles[0].mappings[0].button, 5);
    }

    #[test]
    fn shift_layer_is_separate() {
        let mut p = profile(DEFAULT_PROFILE, None, vec![key(4, &["a"])]);
        p.shift_mappings = vec![key(4, &["b"]), Mapping { button: 5, action: Action::Shift }];
        let cfg = config(vec![p], vec![]).sanitized();
        assert_eq!(cfg.action_for(DEFAULT_PROFILE, 4, false), Some(&Action::Key { keys: vec!["a".into()] }));
        assert_eq!(cfg.action_for(DEFAULT_PROFILE, 4, true), Some(&Action::Key { keys: vec!["b".into()] }));
        // A Shift button inside the Shift layer is dropped.
        assert_eq!(cfg.action_for(DEFAULT_PROFILE, 5, true), None);
    }

    #[test]
    fn clamps_macro_limits() {
        let cfg = config(
            vec![],
            vec![MacroDef {
                id: "m".into(),
                name: "M".into(),
                repeat: Repeat::Loop { count: 999_999 },
                events: vec![MacroEvent::Delay { ms: 9_999_999 }],
            }],
        )
        .sanitized();
        assert_eq!(cfg.macros[0].repeat, Repeat::Loop { count: MAX_LOOPS });
        assert_eq!(cfg.macros[0].events[0], MacroEvent::Delay { ms: MAX_DELAY_MS });
    }

    #[test]
    fn clamps_perf_values_and_handles_bad_numbers() {
        let mut p = profile(DEFAULT_PROFILE, None, vec![]);
        p.perf.native_dpi = 5;
        p.perf.stages = vec![];
        p.perf.active_stage = 9;
        p.perf.rotation = f32::NAN;
        p.perf.y_ratio = 99.0;
        p.perf.smoothing = 5.0;
        p.perf.scroll.lines = 0;
        p.perf.accel.limit = f32::INFINITY;
        p.perf.accel.points = vec![[9.0, 2.0]];
        let cfg = config(vec![p], vec![]).sanitized();
        let perf = &cfg.profiles[0].perf;
        assert_eq!(perf.native_dpi, 50);
        assert_eq!(perf.stages.len(), 6);
        assert!(perf.active_stage < perf.stages.len());
        assert_eq!(perf.rotation, 0.0);
        assert_eq!(perf.y_ratio, 4.0);
        assert_eq!(perf.smoothing, 0.98);
        assert_eq!(perf.scroll.lines, 1);
        assert_eq!(perf.accel.limit, 2.5);
        assert!(perf.accel.points.len() >= 2);
    }

    #[test]
    fn stage_dpi_and_movement_need() {
        let mut perf = Perf::default();
        // The default stages ascend and the starting one is the mouse's own 1600 DPI.
        let dpis: Vec<u32> = perf.stages.iter().map(|s| s.dpi).collect();
        assert_eq!(dpis, vec![400, 800, 1200, 1600, 2400, 3200]);
        assert_eq!(perf.stage_dpi(perf.active_stage), (1600, 1600));
        // Native sensitivity with no processing needs no software movement at all.
        assert!(!perf.needs_movement(3));
        assert!(perf.needs_movement(0), "a stage other than the mouse's own DPI needs processing");
        perf.stages[3].dpi_y = Some(1200);
        assert_eq!(perf.stage_dpi(3), (1600, 1600), "independent X/Y is off");
        perf.independent_xy = true;
        assert_eq!(perf.stage_dpi(3), (1600, 1200));
        assert!(perf.needs_movement(3));
    }

    #[test]
    fn dpi_actions_are_validated() {
        let mut p = profile(
            DEFAULT_PROFILE,
            None,
            vec![
                Mapping { button: 4, action: Action::Dpi { op: "cycle".into(), stage: 0 } },
                Mapping { button: 5, action: Action::Dpi { op: "explode".into(), stage: 0 } },
                Mapping { button: 3, action: Action::Dpi { op: "hold".into(), stage: 99 } },
            ],
        );
        p.perf = Perf::default();
        let cfg = config(vec![p], vec![]).sanitized();
        let maps = &cfg.profiles[0].mappings;
        assert_eq!(maps.len(), 2);
        assert!(maps.iter().any(|m| m.action == Action::Dpi { op: "hold".into(), stage: 5 }));
    }

    #[test]
    fn stages_are_kept_ascending_and_references_follow() {
        let mut p = profile(
            DEFAULT_PROFILE,
            None,
            vec![
                // Points at 400 DPI, which is last in the list below.
                Mapping { button: 4, action: Action::Dpi { op: "hold".into(), stage: 3 } },
                Mapping { button: 5, action: Action::Dpi { op: "set".into(), stage: 0 } },
            ],
        );
        p.perf.stages = vec![800, 1600, 3200, 400].into_iter().map(|dpi| Stage { dpi, dpi_y: None }).collect();
        p.perf.active_stage = 1; // 1600
        let cfg = config(vec![p], vec![]).sanitized();
        let perf = &cfg.profiles[0].perf;
        assert_eq!(perf.stages.iter().map(|s| s.dpi).collect::<Vec<_>>(), vec![400, 800, 1600, 3200]);
        assert_eq!(perf.stages[perf.active_stage].dpi, 1600, "the active stage keeps its DPI");
        let m = &cfg.profiles[0].mappings;
        assert!(m.iter().any(|x| x.button == 4 && x.action == Action::Dpi { op: "hold".into(), stage: 0 }), "400 DPI is now first");
        assert!(m.iter().any(|x| x.button == 5 && x.action == Action::Dpi { op: "set".into(), stage: 1 }), "800 DPI is now second");
        // Sorting again changes nothing.
        let again = cfg.clone().sanitized();
        assert_eq!(again, cfg);
    }
}
