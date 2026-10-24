import type { SessionDetail, SessionSettings, SessionState, SessionSummary } from "./engine";

/**
 * Sample sessions for the browser demo, so the Sessions screen can be developed and photographed
 * without a game. The numbers are made up but follow what the engine records.
 */

const MIN = 60_000;
const BUCKET = 10_000;

/** A small repeatable pseudo-random number in [0, 1). */
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const BASE: SessionSettings = {
  profile: "default", dpi_x: 1600, dpi_y: 1600, accel: "off", snap: false, snap_degrees: 6, smoothing: 0.5,
  precision: true, precision_below: 1.2, precision_factor: 0.6, speed_limit: 0, rotation: 0, kernel: true, remaps: false, game_pause_setting: true,
};

interface Plan {
  id: string;
  name: string;
  exe: string;
  start: number;
  length: number;
  live?: boolean;
  lateStart?: boolean;
  endedBy?: string;
  /** [state, minutes] in order. */
  states: [SessionState, number][];
  /** Minutes after the start at which the settings change, and the change. */
  changes: [number, Partial<SessionSettings>][];
  first: Partial<SessionSettings>;
  /** Minutes in which the engine resent movement itself and Windows refused it. */
  refused?: [number, number][];
}

function build(p: Plan): SessionDetail {
  let at = p.start;
  const segments: SessionDetail["segments"] = [];
  for (const [state, mins] of p.states) {
    segments.push([state, at, at + mins * MIN]);
    at += mins * MIN;
  }
  const end = at;
  const stateAt = (t: number): SessionState => segments.find((s) => t >= s[1] && t < s[2])?.[0] ?? "working";

  const notes: SessionDetail["notes"] = [{ t: p.start, settings: { ...BASE, ...p.first } }];
  let current = notes[0].settings;
  for (const [m, change] of p.changes) {
    current = { ...current, ...change };
    notes.push({ t: p.start + m * MIN, settings: current });
  }
  const settingsAt = (t: number) => [...notes].reverse().find((n) => t >= n.t)?.settings ?? notes[0].settings;

  const buckets: SessionDetail["buckets"] = [];
  const kernelBuckets = new Set<number>();
  for (let t = p.start; t < end; t += BUCKET) {
    const state = stateAt(t);
    const i = (t - p.start) / BUCKET;
    // Rounds: about two minutes of play, then half a minute of buying and waiting.
    const phase = i % 15;
    const rate = state === "offline" ? 0 : phase < 12 ? 120 + rnd(i) * 520 + Math.sin(i / 3) * 90 : 15 + rnd(i + 3) * 40;
    const moves = Math.round(rate * 10);
    const kernel = settingsAt(t).kernel && state === "working";
    if (kernel) kernelBuckets.add(t);
    const refused = p.refused?.some(([a, b]) => t >= p.start + a * MIN && t < p.start + b * MIN) ?? false;
    const resent = !kernel && (state === "working" || state === "blocked") ? Math.round(moves * 0.9) : 0;
    buckets.push([t, moves, resent, refused ? 0 : resent, refused ? Math.round(resent * 0.95) : 0, state === "working" && phase < 12 ? Math.round(rnd(i + 9) * 4) : 0, state === "offline" ? 0 : 1]);
  }

  const sum = (f: (b: SessionDetail["buckets"][number]) => number) => buckets.reduce((a, b) => a + f(b), 0);
  const ms = (s: SessionState) => segments.filter((g) => g[0] === s).reduce((a, g) => a + (g[2] - g[1]), 0);
  const kernelMs = kernelBuckets.size * BUCKET;

  return {
    id: p.id, exe: p.exe, name: p.name, started: p.start, ended: p.live ? null : end, last_seen: end,
    ended_by: p.live ? null : p.endedBy ?? "The app was closed", late_start: !!p.lateStart, live: !!p.live,
    duration_ms: end - p.start,
    working_ms: ms("working"), standby_ms: ms("standby"), paused_ms: ms("paused"), game_pause_ms: ms("game_pause"),
    blocked_ms: ms("blocked"), kernel_error_ms: ms("kernel_error"), offline_ms: ms("offline"),
    kernel_ms: kernelMs, front_ms: Math.round((end - p.start) * 0.93),
    moves: sum((b) => b[1]), sent: sum((b) => b[2]), seen: sum((b) => b[3]), refused: sum((b) => b[4]), buttons: sum((b) => b[5]),
    settings_changes: notes.length - 1,
    segments, buckets, notes,
  };
}

export function demoSessions(now = Date.now()): SessionDetail[] {
  const day = 24 * 60 * MIN;
  const plans: Plan[] = [
    {
      id: "demo-live", name: "Valorant", exe: "valorant-win64-shipping.exe", start: now - 52 * MIN, length: 52, live: true,
      states: [["working", 52]], first: {}, changes: [[31, { smoothing: 0.8 }]],
    },
    {
      id: "demo-2", name: "Valorant", exe: "valorant-win64-shipping.exe", start: now - day + 40 * MIN, length: 132,
      states: [["working", 132]], first: {}, changes: [[65, { snap: true, snap_degrees: 12 }]],
    },
    {
      id: "demo-3", name: "Valorant", exe: "valorant-win64-shipping.exe", start: now - 2 * day - 30 * MIN, length: 107,
      states: [["game_pause", 18], ["working", 52], ["paused", 4], ["working", 33]], first: { kernel: false, precision: false },
      changes: [[18, { kernel: true }]],
    },
    {
      id: "demo-4", name: "Valorant", exe: "valorant-win64-shipping.exe", start: now - 4 * day, length: 48, lateStart: true,
      states: [["offline", 6], ["working", 15], ["blocked", 3], ["working", 24]], first: { kernel: false, remaps: true },
      changes: [], refused: [[21, 24]],
    },
  ];
  return plans.map(build);
}

export function summarize(d: SessionDetail): SessionSummary {
  const { segments: _s, buckets: _b, notes: _n, ...summary } = d;
  void _s; void _b; void _n;
  return summary;
}
