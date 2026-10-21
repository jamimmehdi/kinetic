//! Acceleration curves. A curve maps hand speed (counts per millisecond) to a sensitivity multiplier.
//! The curve is sampled once into a table when the config changes, so the per-event cost is one lookup.

use crate::config::{Accel, AccelMode, CurveKind};

/// Highest speed the table covers, in counts per millisecond.
pub const V_MAX: f32 = 32.0;
const SAMPLES: usize = 1024;
/// Output speed limit used when the "speed cap" option is on, in counts per millisecond.
const SPEED_CAP: f32 = 12.0;

pub struct Curve {
    table: Vec<f32>,
    step: f32,
    /// Gain curves keep the integral at V_MAX and the slope there, to extend past the table.
    tail: Option<(f32, f32)>,
    cap: bool,
    identity: bool,
}

impl Curve {
    pub fn identity() -> Curve {
        Curve { table: vec![1.0], step: 1.0, tail: None, cap: false, identity: true }
    }

    pub fn build(a: &Accel) -> Curve {
        if a.mode == AccelMode::Off {
            return Curve::identity();
        }
        let step = V_MAX / SAMPLES as f32;
        let mut table = Vec::with_capacity(SAMPLES + 1);
        let mut tail = None;
        match a.kind {
            CurveKind::Sensitivity => {
                for i in 0..=SAMPLES {
                    table.push(value(a, i as f32 * step).max(0.0));
                }
            }
            CurveKind::Gain => {
                // Sensitivity = output speed / input speed, and output speed is the integral of the gain.
                let mut integral = 0.0f32;
                let mut prev = value(a, 0.0).max(0.0);
                table.push(prev);
                for i in 1..=SAMPLES {
                    let g = value(a, i as f32 * step).max(0.0);
                    integral += 0.5 * (prev + g) * step;
                    table.push(integral / (i as f32 * step));
                    prev = g;
                }
                tail = Some((integral, prev));
            }
        }
        Curve { table, step, tail, cap: a.speed_cap, identity: false }
    }

    #[cfg(test)]
    pub fn is_identity(&self) -> bool {
        self.identity
    }

    /// Sensitivity multiplier at speed `v`.
    pub fn multiplier(&self, v: f32) -> f32 {
        if self.identity {
            return 1.0;
        }
        let v = if v.is_finite() { v.max(0.0) } else { 0.0 };
        let mut m = if v >= V_MAX {
            match self.tail {
                Some((integral, gain)) => (integral + gain * (v - V_MAX)) / v,
                None => *self.table.last().unwrap_or(&1.0),
            }
        } else {
            let pos = v / self.step;
            let i = pos as usize;
            let frac = pos - i as f32;
            let a = self.table[i];
            let b = self.table[(i + 1).min(self.table.len() - 1)];
            a + (b - a) * frac
        };
        if self.cap && v > 0.0 {
            m = m.min(SPEED_CAP / v);
        }
        m
    }

    /// Curve samples for drawing, as (speed, multiplier) pairs.
    #[cfg(test)]
    pub fn sample(&self, v: f32) -> f32 {
        self.multiplier(v)
    }
}

/// The curve's value at speed `v` before any gain integration.
fn value(a: &Accel, v: f32) -> f32 {
    let x = (v - a.offset).max(0.0);
    let limit = a.limit.max(1.0);
    let m = match a.mode {
        AccelMode::Off => 1.0,
        AccelMode::Linear => 1.0 + a.rate * x,
        AccelMode::Classic => {
            if a.exponent > 1.0 {
                1.0 + (a.rate * x).powf(a.exponent - 1.0)
            } else {
                1.0 + a.rate * x
            }
        }
        AccelMode::Natural => {
            let rx = a.rate * x;
            if rx < 1e-6 {
                1.0
            } else {
                1.0 + (limit - 1.0) * (1.0 - (1.0 - (-rx).exp()) / rx)
            }
        }
        AccelMode::Sigmoid => {
            // Shifted so the curve starts at exactly 1.0 when the hand is still.
            let s = |v: f32| 1.0 / (1.0 + (-a.rate * (v - a.midpoint)).exp());
            1.0 + (limit - 1.0) * (s(v) - s(0.0)) / (1.0 - s(0.0)).max(1e-6)
        }
        AccelMode::Power => (a.rate * x).powf(a.exponent).max(1.0),
        AccelMode::Jump => {
            let t = 1.0 / (1.0 + (-8.0 * (v - a.midpoint)).exp());
            1.0 + (limit - 1.0) * t
        }
        AccelMode::Custom => return interpolate(&a.points, v),
    };
    // Natural and sigmoid already top out at the limit; the rest are clamped to it.
    match a.mode {
        AccelMode::Natural | AccelMode::Sigmoid | AccelMode::Jump => m,
        _ => m.min(limit),
    }
}

fn interpolate(points: &[[f32; 2]], v: f32) -> f32 {
    match points {
        [] => 1.0,
        [only] => only[1],
        _ => {
            if v <= points[0][0] {
                return points[0][1];
            }
            for w in points.windows(2) {
                let (a, b) = (w[0], w[1]);
                if v <= b[0] {
                    let span = (b[0] - a[0]).max(1e-6);
                    return a[1] + (b[1] - a[1]) * (v - a[0]) / span;
                }
            }
            points[points.len() - 1][1]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accel(mode: AccelMode) -> Accel {
        Accel { mode, ..Accel::default() }
    }

    #[test]
    fn off_is_exactly_one() {
        let c = Curve::build(&accel(AccelMode::Off));
        assert!(c.is_identity());
        assert_eq!(c.multiplier(0.0), 1.0);
        assert_eq!(c.multiplier(20.0), 1.0);
    }

    #[test]
    fn every_curve_starts_at_one_and_stays_positive() {
        for mode in [AccelMode::Linear, AccelMode::Classic, AccelMode::Natural, AccelMode::Sigmoid, AccelMode::Power, AccelMode::Jump, AccelMode::Custom] {
            let c = Curve::build(&accel(mode));
            let start = c.multiplier(0.0);
            assert!((start - 1.0).abs() < 0.02, "{mode:?} starts at {start}");
            for v in [0.0, 0.5, 2.0, 5.0, 20.0, 40.0] {
                let m = c.multiplier(v);
                assert!(m.is_finite() && m > 0.0, "{mode:?} at {v} gave {m}");
            }
        }
    }

    #[test]
    fn linear_rises_and_respects_the_limit() {
        let a = Accel { mode: AccelMode::Linear, rate: 0.5, limit: 3.0, ..Accel::default() };
        let c = Curve::build(&a);
        assert!((c.multiplier(2.0) - 2.0).abs() < 0.01);
        assert!((c.multiplier(30.0) - 3.0).abs() < 0.01);
    }

    #[test]
    fn offset_leaves_slow_movement_alone() {
        let a = Accel { mode: AccelMode::Linear, rate: 1.0, offset: 3.0, limit: 10.0, ..Accel::default() };
        let c = Curve::build(&a);
        assert!((c.multiplier(2.9) - 1.0).abs() < 0.01);
        assert!(c.multiplier(5.0) > 2.5);
    }

    #[test]
    fn sigmoid_midpoint_and_ceiling() {
        let a = Accel { mode: AccelMode::Sigmoid, rate: 1.0, midpoint: 4.0, limit: 3.0, ..Accel::default() };
        let c = Curve::build(&a);
        let mid = c.multiplier(4.0);
        assert!(mid > 1.8 && mid < 2.2, "midpoint gave {mid}");
        assert!(c.multiplier(30.0) > 2.9 && c.multiplier(30.0) <= 3.0 + 1e-3);
    }

    #[test]
    fn natural_approaches_its_limit() {
        let a = Accel { mode: AccelMode::Natural, rate: 0.5, limit: 2.5, ..Accel::default() };
        let c = Curve::build(&a);
        assert!(c.multiplier(1.0) < c.multiplier(10.0));
        assert!(c.multiplier(31.0) < 2.5);
    }

    #[test]
    fn jump_switches_at_the_midpoint() {
        let a = Accel { mode: AccelMode::Jump, midpoint: 5.0, limit: 2.0, ..Accel::default() };
        let c = Curve::build(&a);
        assert!(c.multiplier(3.0) < 1.05);
        assert!(c.multiplier(7.0) > 1.95);
    }

    #[test]
    fn custom_points_interpolate_and_extend_flat() {
        let a = Accel { mode: AccelMode::Custom, points: vec![[0.0, 1.0], [10.0, 3.0]], ..Accel::default() };
        let c = Curve::build(&a);
        assert!((c.multiplier(5.0) - 2.0).abs() < 0.01);
        assert!((c.multiplier(25.0) - 3.0).abs() < 0.01);
    }

    #[test]
    fn gain_curves_integrate() {
        // Constant gain 2 means sensitivity 2 at every speed once past the origin.
        let a = Accel { mode: AccelMode::Custom, kind: CurveKind::Gain, points: vec![[0.0, 2.0], [32.0, 2.0]], ..Accel::default() };
        let c = Curve::build(&a);
        assert!((c.multiplier(3.0) - 2.0).abs() < 0.01);
        assert!((c.multiplier(50.0) - 2.0).abs() < 0.01, "beyond the table");
        // A rising gain gives sensitivity that lags the gain itself.
        let b = Accel { mode: AccelMode::Linear, kind: CurveKind::Gain, rate: 1.0, limit: 20.0, ..Accel::default() };
        let cb = Curve::build(&b);
        assert!(cb.multiplier(4.0) < 1.0 + 4.0);
        assert!(cb.multiplier(4.0) > 1.0);
    }

    #[test]
    fn speed_cap_limits_output_speed() {
        let a = Accel { mode: AccelMode::Linear, rate: 5.0, limit: 20.0, speed_cap: true, ..Accel::default() };
        let c = Curve::build(&a);
        let v = 10.0;
        assert!(c.multiplier(v) * v <= SPEED_CAP + 0.01);
    }

    #[test]
    fn bad_input_speeds_are_safe() {
        let c = Curve::build(&accel(AccelMode::Linear));
        assert!(c.multiplier(f32::NAN).is_finite());
        assert!(c.multiplier(-5.0).is_finite());
        assert!(c.sample(1e9).is_finite());
    }
}

/// Golden values shared with the UI's TypeScript port (app/tests/accel-parity.ts), so the curve the
/// editor draws is the curve the engine applies. Regenerate with UPDATE_GOLDEN=1 cargo test golden.
#[cfg(test)]
mod golden {
    use super::*;

    const SPEEDS: [f32; 9] = [0.0, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 31.0, 40.0];

    fn cases() -> Vec<Accel> {
        let base = Accel::default();
        let mut out = Vec::new();
        for kind in [CurveKind::Sensitivity, CurveKind::Gain] {
            for mode in [
                AccelMode::Off,
                AccelMode::Linear,
                AccelMode::Classic,
                AccelMode::Natural,
                AccelMode::Sigmoid,
                AccelMode::Power,
                AccelMode::Jump,
                AccelMode::Custom,
            ] {
                out.push(Accel { mode, kind, ..base.clone() });
                out.push(Accel { mode, kind, rate: 0.3, offset: 1.5, limit: 4.0, midpoint: 6.0, exponent: 3.0, speed_cap: true, ..base.clone() });
            }
        }
        out
    }

    fn path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("app").join("tests").join("accel-golden.json")
    }

    #[test]
    fn golden_values_match_fixture() {
        let rows: Vec<serde_json::Value> = cases()
            .into_iter()
            .map(|a| {
                let c = Curve::build(&a);
                let values: Vec<f64> = SPEEDS.iter().map(|&v| (c.multiplier(v) as f64 * 1e5).round() / 1e5).collect();
                serde_json::json!({ "accel": a, "speeds": SPEEDS, "values": values })
            })
            .collect();
        let text = serde_json::to_string_pretty(&rows).unwrap();
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::create_dir_all(path().parent().unwrap()).unwrap();
            std::fs::write(path(), text).unwrap();
            return;
        }
        let saved = std::fs::read_to_string(path()).expect("fixture missing: run with UPDATE_GOLDEN=1");
        let old: Vec<serde_json::Value> = serde_json::from_str(&saved).unwrap();
        assert_eq!(old.len(), rows.len());
        for (o, n) in old.iter().zip(&rows) {
            for (a, b) in o["values"].as_array().unwrap().iter().zip(n["values"].as_array().unwrap()) {
                assert!((a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < 1e-4, "curve changed: {o} vs {n}");
            }
        }
    }
}
