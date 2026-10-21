import { useMemo, useState } from "react";
import { buildCurve } from "../accel";
import { TremorTest } from "../TremorTest";
import { Slider, Tag, Toggle, Top } from "../ui";
import { DEFAULT_STEADY, getProfile, withProfile, type EngineState, type Steady } from "../engine";

/** Ready-made settings, from none to strong. They only fill in the fields below. */
const PRESETS: { id: string; label: string; note: string; change: Partial<Steady> }[] = [
  { id: "off", label: "Off", note: "No steadying.", change: { precision: false, speed_smoothing: DEFAULT_STEADY.speed_smoothing } },
  { id: "light", label: "Light", note: "A little calm for slow movement.", change: { precision: true, precision_below: 0.8, precision_factor: 0.8, speed_smoothing: 0.6 } },
  { id: "medium", label: "Medium", note: "Clear steadying for a visible tremor.", change: { precision: true, precision_below: 1.2, precision_factor: 0.6, speed_smoothing: 0.75 } },
  { id: "strong", label: "Strong", note: "Heavy steadying for strong shaking.", change: { precision: true, precision_below: 2, precision_factor: 0.45, speed_smoothing: 0.85 } },
];

interface Props {
  engine: EngineState;
  profileId: string;
  onProfileChange(id: string): void;
}

/** Settings that calm a shaky or uneven hand. They only reshape movement; they never look at the game. */
export function SteadyScreen({ engine, profileId, onProfileChange }: Props) {
  const { config } = engine;
  const profile = getProfile(config, profileId);
  const perf = profile.perf;
  const s = perf.steady;
  const [testing, setTesting] = useState(false);

  const updateSteady = (change: Partial<Steady>) =>
    engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, perf: { ...p.perf, steady: { ...p.perf.steady, ...change } } })));
  const updatePerf = (change: (p: typeof perf) => typeof perf) =>
    engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, perf: change(p.perf) })));

  // The curve the engine applies, from standstill to a moderate flick, to preview the precision zone.
  const SPAN = 8;
  const curve = useMemo(() => buildCurve(perf.accel, s), [perf.accel, s]);
  const points = useMemo(() => Array.from({ length: 81 }, (_, i) => [(i / 80) * SPAN, curve.multiplier((i / 80) * SPAN)] as const), [curve]);
  const top = Math.max(1.2, ...points.map((p) => p[1]));
  const W = 520, H = 170, L = 38, R = 12, T = 12, B = 26;
  const x = (v: number) => L + (v / SPAN) * (W - L - R);
  const y = (m: number) => T + (1 - m / top) * (H - T - B);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join("");

  const activePreset = PRESETS.find((p) => {
    const c = p.change;
    if (!c.precision) return !s.precision;
    return s.precision && c.precision_below === s.precision_below && c.precision_factor === s.precision_factor && c.speed_smoothing === s.speed_smoothing;
  })?.id;

  const row = (label: string, value: string, control: React.ReactNode, hint?: string) => (
    <div className="row plain" style={{ minHeight: 44, gap: 14 }} title={hint}>
      <span style={{ width: 150, flex: "none" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 40 }}>{control}</div>
      <span className="num sub" style={{ width: 64, textAlign: "right", flex: "none" }}>{value}</span>
    </div>
  );

  return (
    <>
      <Top title="Steady hand" sub="Calm a shaky or uneven hand. These only reshape your own movement and never look at the game.">
        <label className="sub" htmlFor="profile-pick">Profile</label>
        <select id="profile-pick" className="input select" value={profile.id} onChange={(e) => onProfileChange(e.target.value)}>
          {config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => setTesting(true)}>Test my hand</button>
      </Top>

      <div className="scroll-y" style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr)", gap: 18, alignContent: "start" }}>
        <div className="card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="lbl">Precision zone</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Tag kind="all">Any mouse · kernel mode</Tag>
              <Toggle label="Precision zone" on={s.precision} onChange={(v) => updateSteady({ precision: v })} />
            </span>
          </div>
          <div className="sub" style={{ fontSize: 13 }}>Very slow movement, where tremor lives, is made less sensitive. Deliberate movement is left alone.</div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Sensitivity against hand speed with the precision zone applied">
            <g style={{ stroke: "var(--bd)" }}>
              {[0, 0.5, 1].map((f) => <path key={f} d={`M${L} ${y(top * f)}H${W - R}`} />)}
            </g>
            <path d={`M${L} ${y(1)}H${W - R}`} style={{ stroke: "var(--mu)" }} strokeDasharray="4 4" fill="none" />
            <path d={path} style={{ stroke: s.precision ? "var(--ac)" : "var(--mu)" }} strokeWidth="2.5" fill="none" strokeLinejoin="round" />
            <g className="sub" style={{ fill: "var(--mu)", fontSize: 11 }}>
              <text x={L - 6} y={y(1) + 4} textAnchor="end">1×</text>
              <text x={L - 6} y={y(top) + 4} textAnchor="end">{top.toFixed(1)}×</text>
              <text x={L} y={H - 6}>0</text>
              <text x={W - R} y={H - 6} textAnchor="end">{SPAN} counts/ms</text>
            </g>
          </svg>
          {row("Below this speed", `${s.precision_below.toFixed(1)}`, <Slider label="Below this speed" width="100%" min={0.1} max={6} step={0.1} value={s.precision_below} disabled={!s.precision} onChange={(v) => updateSteady({ precision_below: v })} />, "Counts per millisecond. About how fast the shaking moves the pointer.")}
          {row("Sensitivity at rest", `${Math.round(s.precision_factor * 100)}%`, <Slider label="Sensitivity at rest" width="100%" min={0.1} max={1} step={0.05} value={s.precision_factor} disabled={!s.precision} onChange={(v) => updateSteady({ precision_factor: v })} />, "How much of normal sensitivity is kept when the hand is nearly still.")}
          {row("Speed smoothing", s.speed_smoothing.toFixed(2), <Slider label="Speed smoothing" width="100%" min={0} max={0.95} step={0.05} value={s.speed_smoothing} onChange={(v) => updateSteady({ speed_smoothing: v })} />, "Smooths the speed used for acceleration so jittery speed does not make the curve jitter. It does not delay the pointer.")}
          <div className="row plain" style={{ minHeight: 44, gap: 14 }}>
            <span style={{ width: 150, flex: "none" }}>Speed limit</span>
            <div style={{ flex: 1, minWidth: 40 }}>
              <Slider label="Speed limit" width="100%" min={2} max={40} step={1} value={s.speed_limit || 12} disabled={s.speed_limit === 0} onChange={(v) => updateSteady({ speed_limit: v })} />
            </div>
            <span className="num sub" style={{ width: 64, textAlign: "right", flex: "none" }}>{s.speed_limit === 0 ? "off" : s.speed_limit}</span>
            <Toggle label="Speed limit" on={s.speed_limit > 0} onChange={(v) => updateSteady({ speed_limit: v ? 12 : 0 })} />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <div className="card" style={{ padding: "20px 22px" }}>
            <div className="lbl" style={{ marginBottom: 10 }}>Presets</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Steady hand presets">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={`chip ${activePreset === p.id ? "on" : ""}`} aria-pressed={activePreset === p.id} onClick={() => updateSteady(p.change)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="sub" style={{ marginTop: 10, fontSize: 13 }}>
              {PRESETS.find((p) => p.id === activePreset)?.note ?? "Custom settings."} Not sure which one? Press <b>Test my hand</b>.
            </div>
          </div>

          <div className="card" style={{ padding: "20px 22px" }}>
            <div className="lbl" style={{ marginBottom: 4 }}>Hand bias</div>
            <div className="sub" style={{ fontSize: 13 }}>If your hand moves better in some directions, scale left and up against right and down.</div>
            {row("Left", s.left_ratio.toFixed(2), <Slider label="Left sensitivity" width="100%" min={0.5} max={1.5} step={0.05} value={s.left_ratio} onChange={(v) => updateSteady({ left_ratio: v })} />)}
            {row("Up", s.up_ratio.toFixed(2), <Slider label="Up sensitivity" width="100%" min={0.5} max={1.5} step={0.05} value={s.up_ratio} onChange={(v) => updateSteady({ up_ratio: v })} />)}
          </div>

          <div className="card" style={{ padding: "20px 22px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="lbl">Angle snapping</span>
              <Toggle label="Angle snapping" on={perf.angle_snap} onChange={(v) => updatePerf((p) => ({ ...p, angle_snap: v }))} />
            </div>
            <div className="sub" style={{ fontSize: 13 }}>Straightens a move that is nearly horizontal or vertical.</div>
            {row("Snap window", `${s.snap_degrees.toFixed(0)}°`, <Slider label="Snap window" width="100%" min={1} max={45} step={1} value={s.snap_degrees} disabled={!perf.angle_snap} onChange={(v) => updateSteady({ snap_degrees: v })} />, "How many degrees from straight a move may be and still be straightened.")}
          </div>
        </div>
      </div>

      {testing && <TremorTest engine={engine} onClose={() => setTesting(false)} onApply={(change) => updateSteady(change)} />}
    </>
  );
}
