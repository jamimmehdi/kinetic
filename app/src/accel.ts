import type { Accel } from "./engine";

/**
 * Acceleration curves, ported from the engine (engine/src/accel.rs) so the editor can draw exactly
 * what the engine will apply. A golden fixture checked by both sides keeps the two in step.
 */

/** Highest speed the curve table covers, in counts per millisecond. */
export const V_MAX = 32;
const SAMPLES = 1024;
/** Output speed limit used by the "speed cap" option, in counts per millisecond. */
export const SPEED_CAP = 12;

function interpolate(points: [number, number][], v: number): number {
  if (points.length === 0) return 1;
  if (points.length === 1) return points[0][1];
  if (v <= points[0][0]) return points[0][1];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (v <= b[0]) {
      const span = Math.max(b[0] - a[0], 1e-6);
      return a[1] + ((b[1] - a[1]) * (v - a[0])) / span;
    }
  }
  return points[points.length - 1][1];
}

/** The curve's value at speed `v` before any gain integration. */
function value(a: Accel, v: number): number {
  const x = Math.max(v - a.offset, 0);
  const limit = Math.max(a.limit, 1);
  let m: number;
  switch (a.mode) {
    case "off":
      m = 1;
      break;
    case "linear":
      m = 1 + a.rate * x;
      break;
    case "classic":
      m = a.exponent > 1 ? 1 + Math.pow(a.rate * x, a.exponent - 1) : 1 + a.rate * x;
      break;
    case "natural": {
      const rx = a.rate * x;
      m = rx < 1e-6 ? 1 : 1 + (limit - 1) * (1 - (1 - Math.exp(-rx)) / rx);
      break;
    }
    case "sigmoid": {
      const s = (t: number) => 1 / (1 + Math.exp(-a.rate * (t - a.midpoint)));
      m = 1 + ((limit - 1) * (s(v) - s(0))) / Math.max(1 - s(0), 1e-6);
      break;
    }
    case "power":
      m = Math.max(Math.pow(a.rate * x, a.exponent), 1);
      break;
    case "jump": {
      const t = 1 / (1 + Math.exp(-8 * (v - a.midpoint)));
      m = 1 + (limit - 1) * t;
      break;
    }
    case "custom":
      return interpolate(a.points, v);
  }
  return a.mode === "natural" || a.mode === "sigmoid" || a.mode === "jump" ? m : Math.min(m, limit);
}

export interface Curve {
  /** Sensitivity multiplier at speed `v` (counts per millisecond). */
  multiplier(v: number): number;
}

export function buildCurve(a: Accel): Curve {
  if (a.mode === "off") return { multiplier: () => 1 };
  const step = V_MAX / SAMPLES;
  const table: number[] = [];
  let tail: [number, number] | null = null;

  if (a.kind === "sensitivity") {
    for (let i = 0; i <= SAMPLES; i++) table.push(Math.max(value(a, i * step), 0));
  } else {
    let integral = 0;
    let prev = Math.max(value(a, 0), 0);
    table.push(prev);
    for (let i = 1; i <= SAMPLES; i++) {
      const g = Math.max(value(a, i * step), 0);
      integral += 0.5 * (prev + g) * step;
      table.push(integral / (i * step));
      prev = g;
    }
    tail = [integral, prev];
  }

  return {
    multiplier(vIn: number): number {
      const v = Number.isFinite(vIn) ? Math.max(vIn, 0) : 0;
      let m: number;
      if (v >= V_MAX) {
        m = tail ? (tail[0] + tail[1] * (v - V_MAX)) / v : table[table.length - 1];
      } else {
        const pos = v / step;
        const i = Math.floor(pos);
        const frac = pos - i;
        const lo = table[i];
        const hi = table[Math.min(i + 1, table.length - 1)];
        m = lo + (hi - lo) * frac;
      }
      if (a.speed_cap && v > 0) m = Math.min(m, SPEED_CAP / v);
      return m;
    },
  };
}
