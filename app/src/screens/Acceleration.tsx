import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { buildCurve } from "../accel";
import { Seg, Slider, Tag, Toggle, Top } from "../ui";
import { DEFAULT_ACCEL, getProfile, withProfile, type Accel, type AccelMode, type EngineState } from "../engine";

const MODES: { id: AccelMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "linear", label: "Linear" },
  { id: "classic", label: "Classic" },
  { id: "natural", label: "Natural" },
  { id: "sigmoid", label: "Sigmoid" },
  { id: "power", label: "Power" },
  { id: "jump", label: "Jump" },
  { id: "custom", label: "Draw custom" },
];

interface Param {
  key: "rate" | "offset" | "limit" | "midpoint" | "exponent";
  label: string;
  min: number;
  max: number;
  step: number;
}

const PARAMS: Record<AccelMode, Param[]> = {
  off: [],
  linear: [
    { key: "rate", label: "Rate", min: 0, max: 2, step: 0.05 },
    { key: "offset", label: "Offset", min: 0, max: 6, step: 0.1 },
    { key: "limit", label: "Max multiplier", min: 1, max: 6, step: 0.1 },
  ],
  classic: [
    { key: "rate", label: "Rate", min: 0, max: 2, step: 0.05 },
    { key: "exponent", label: "Power", min: 1, max: 4, step: 0.1 },
    { key: "offset", label: "Offset", min: 0, max: 6, step: 0.1 },
    { key: "limit", label: "Max multiplier", min: 1, max: 6, step: 0.1 },
  ],
  natural: [
    { key: "rate", label: "Growth rate", min: 0.05, max: 2, step: 0.05 },
    { key: "offset", label: "Offset", min: 0, max: 6, step: 0.1 },
    { key: "limit", label: "Max multiplier", min: 1, max: 6, step: 0.1 },
  ],
  sigmoid: [
    { key: "rate", label: "Growth rate", min: 0.1, max: 3, step: 0.05 },
    { key: "midpoint", label: "Midpoint", min: 0, max: 8, step: 0.1 },
    { key: "limit", label: "Max multiplier", min: 1, max: 6, step: 0.1 },
  ],
  power: [
    { key: "rate", label: "Scale", min: 0.05, max: 2, step: 0.05 },
    { key: "exponent", label: "Exponent", min: 0.1, max: 2, step: 0.05 },
    { key: "offset", label: "Offset", min: 0, max: 6, step: 0.1 },
    { key: "limit", label: "Max multiplier", min: 1, max: 6, step: 0.1 },
  ],
  jump: [
    { key: "midpoint", label: "Jump speed", min: 0.5, max: 8, step: 0.1 },
    { key: "limit", label: "Multiplier", min: 1, max: 6, step: 0.1 },
  ],
  custom: [],
};

// Graph: speed 0..V_AXIS across, multiplier Y_MIN upward. The drawing is sized to its box.
const V_AXIS = 8;
const Y_MIN = 0.5;
const PAD = { left: 56, right: 16, top: 16, bottom: 34 };
const Y_STEPS = [0.25, 0.5, 1, 2, 4, 8];

const fmt = (v: number) => `${Number(v.toFixed(2))}×`;

/** Track the pixel size of an element so the graph can fill it exactly. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

interface Props {
  engine: EngineState;
  profileId: string;
  onProfileChange(id: string): void;
}

export function AccelerationScreen({ engine, profileId, onProfileChange }: Props) {
  const { config, telemetry } = engine;
  const profile = getProfile(config, profileId);
  const perf = profile.perf;
  const accel = perf.accel;

  const update = (change: (a: Accel) => Accel) =>
    engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, perf: { ...p.perf, accel: change(p.perf.accel) } })));
  const updatePerf = (change: (p: typeof perf) => typeof perf) =>
    engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, perf: change(p.perf) })));

  const curve = useMemo(() => buildCurve(accel), [accel]);
  const samples = useMemo(() => Array.from({ length: 161 }, (_, i) => curve.multiplier((i / 160) * V_AXIS)), [curve]);
  const peak = Math.max(...samples, accel.mode === "custom" ? Math.max(...accel.points.map((p) => p[1])) : 0);

  // Five evenly spaced horizontal lines with round labels, as low a top as still holds the curve.
  const step = Y_STEPS.find((s) => Y_MIN + 4 * s >= peak - 1e-6) ?? 8;
  const yMax = Y_MIN + 4 * step;
  const ticks = [0, 1, 2, 3, 4].map((i) => Y_MIN + i * step);

  const [boxRef, { w, h }] = useBoxSize();
  const X0 = PAD.left, X1 = w - PAD.right, Y0 = PAD.top, Y1 = h - PAD.bottom;
  const sx = (v: number) => X0 + (Math.min(v, V_AXIS) / V_AXIS) * (X1 - X0);
  const sy = (m: number) => Y1 - ((Math.min(Math.max(m, Y_MIN), yMax) - Y_MIN) / (yMax - Y_MIN)) * (Y1 - Y0);

  const line = "M" + samples.map((m, i) => `${sx((i / 160) * V_AXIS).toFixed(1)} ${sy(m).toFixed(1)}`).join(" L");
  const area = `${line} L${X1} ${Y1} L${X0} ${Y1} Z`;

  const speed = telemetry?.moving ? telemetry.speed : 0;
  const liveMult = curve.multiplier(speed);
  const marker = telemetry?.moving ? { x: sx(speed), y: sy(liveMult) } : null;

  // ---- drawing a custom curve ----
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const toData = (e: PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    const py = ((e.clientY - r.top) / r.height) * h;
    const v = Math.min(Math.max(((px - X0) / (X1 - X0)) * V_AXIS, 0), V_AXIS);
    const m = Math.min(Math.max(Y_MIN + ((Y1 - py) / (Y1 - Y0)) * (yMax - Y_MIN), 0.1), yMax);
    return [Number(v.toFixed(2)), Number(m.toFixed(2))];
  };
  const custom = accel.mode === "custom";
  const setPoints = (points: [number, number][]) => update((a) => ({ ...a, points: points.slice().sort((p, q) => p[0] - q[0]) }));

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!custom) return;
    const target = (e.target as SVGElement).getAttribute("data-point");
    if (target !== null) {
      setDrag(Number(target));
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    const [v, m] = toData(e);
    setPoints([...accel.points, [v, m]]);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag === null || e.buttons !== 1) return;
    const [v, m] = toData(e);
    setPoints(accel.points.map((p, i) => (i === drag ? [v, m] : p)));
  };

  const params = PARAMS[accel.mode];

  return (
    <>
      <Top title="Acceleration" sub="Shape how hand speed turns into pointer speed. Works on any mouse.">
        <label className="sub" htmlFor="profile-pick">Profile</label>
        <select id="profile-pick" className="input select" value={profile.id} onChange={(e) => onProfileChange(e.target.value)}>
          {config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Seg<Accel["kind"]> label="Curve type" value={accel.kind} onChange={(kind) => update((a) => ({ ...a, kind }))} options={[{ id: "sensitivity", label: "Sensitivity" }, { id: "gain", label: "Gain" }]} />
      </Top>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0,1.7fr) minmax(0,1fr)", gap: 18 }}>
        <div className="card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Curve">
            {MODES.map((m) => (
              <button key={m.id} type="button" className={`chip ${accel.mode === m.id ? "on" : ""}`} aria-pressed={accel.mode === m.id} onClick={() => update((a) => ({ ...a, mode: m.id }))}>
                {m.label}
              </button>
            ))}
          </div>
          <div ref={boxRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${w} ${h}`}
              width={w}
              height={h}
              style={{ position: "absolute", inset: 0, cursor: custom ? "crosshair" : "default", touchAction: "none" }}
              role="img"
              aria-label={`${accel.mode} ${accel.kind} curve against input speed${marker ? ", with a live position marker" : ""}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={() => setDrag(null)}
            >
              <g style={{ stroke: "var(--bd)" }}>
                {ticks.map((t) => <path key={t} d={`M${X0} ${sy(t)}H${X1}`} />)}
                {[0, 2, 4, 6, 8].map((v) => <path key={v} d={`M${sx(v)} ${Y0}V${Y1}`} />)}
              </g>
              {accel.mode !== "off" && <path d={area} style={{ fill: "var(--acs)" }} />}
              <path d={line} fill="none" style={{ stroke: "var(--ac)" }} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
              {marker && (
                <>
                  <path d={`M${marker.x} ${marker.y}V${Y1}`} style={{ stroke: "var(--ok)" }} strokeWidth="1.5" strokeDasharray="4 5" />
                  <circle cx={marker.x} cy={marker.y} r="7" style={{ fill: "var(--ok)", stroke: "var(--card)" }} strokeWidth="3" />
                </>
              )}
              {custom && accel.points.map((p, i) => (
                <circle
                  key={i}
                  data-point={i}
                  cx={sx(p[0])}
                  cy={sy(p[1])}
                  r="8"
                  style={{ fill: "var(--card)", stroke: "var(--ac)", cursor: "grab" }}
                  strokeWidth="3"
                  onDoubleClick={() => accel.points.length > 2 && setPoints(accel.points.filter((_, j) => j !== i))}
                />
              ))}
              <g fontFamily="JetBrains Mono Variable, ui-monospace, monospace" fontSize="11" style={{ fill: "var(--mu)" }}>
                {ticks.map((t) => <text key={t} x={X0 - 10} y={sy(t) + 4} textAnchor="end">{fmt(t)}</text>)}
                {[0, 2, 4, 6, 8].map((v) => <text key={v} x={sx(v)} y={Y1 + 18} textAnchor="middle">{v}</text>)}
                <text x={(X0 + X1) / 2} y={Y1 + 32} textAnchor="middle">Input speed (counts/ms)</text>
              </g>
            </svg>
          </div>
          {custom && <div className="sub">Click the graph to add a point, drag a point to move it, double-click a point to remove it.</div>}
          <div style={{ display: "flex", gap: 30, alignItems: "center" }}>
            <div>
              <div className="num" style={{ fontSize: 28, lineHeight: 1, color: "var(--act)" }}>{liveMult.toFixed(1)}×</div>
              <div className="sub" style={{ marginTop: 4 }}>Live multiplier</div>
            </div>
            <div>
              <div className="num" style={{ fontSize: 28, lineHeight: 1 }}>{speed.toFixed(1)}</div>
              <div className="sub" style={{ marginTop: 4 }}>Current speed</div>
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" className="chip" onClick={() => update((a) => ({ ...DEFAULT_ACCEL, mode: a.mode, kind: a.kind, per_axis: a.per_axis, points: DEFAULT_ACCEL.points.map((p) => [...p] as [number, number]) }))}>
              Reset curve
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minHeight: 0, minWidth: 0 }}>
          <div className="card" style={{ padding: "20px 22px" }}>
            <div className="lbl" style={{ marginBottom: 6 }}>
              {accel.mode === "off" ? "Curve" : `${MODES.find((m) => m.id === accel.mode)?.label.replace("Draw ", "")} parameters`}
            </div>
            {accel.mode === "off" && <div className="sub" style={{ padding: "8px 0" }}>Acceleration is off. Pick a curve to shape it.</div>}
            {params.map((p) => (
              <div key={p.key} className="row plain" style={{ minHeight: 42, gap: 14 }}>
                <span style={{ width: 112, flex: "none" }}>{p.label}</span>
                <div style={{ flex: 1, minWidth: 40 }}>
                  <Slider label={p.label} width="100%" min={p.min} max={p.max} step={p.step} value={accel[p.key]} onChange={(v) => update((a) => ({ ...a, [p.key]: v }))} />
                </div>
                <span className="num sub" style={{ width: 36, textAlign: "right", flex: "none" }}>{Number(accel[p.key].toFixed(2))}</span>
              </div>
            ))}
            {accel.mode !== "off" && (
              <div className="row plain" style={{ minHeight: 42 }}>
                <span>Speed cap</span>
                <Toggle label="Speed cap" on={accel.speed_cap} onChange={(v) => update((a) => ({ ...a, speed_cap: v }))} />
              </div>
            )}
          </div>

          <div className="card" style={{ padding: "20px 22px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="lbl">Direction</span>
              <Tag kind="all">Any mouse</Tag>
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flex: 1, minHeight: 0 }}>
              <svg viewBox="0 0 120 120" width="96" height="96" style={{ flex: "none" }} role="img" aria-label={`Rotation dial set to ${perf.rotation} degrees`}>
                <circle cx="60" cy="60" r="50" fill="none" style={{ stroke: "var(--bd)" }} strokeWidth="3" />
                <g style={{ stroke: "var(--mu)" }} strokeWidth="2"><path d="M60 6v8M60 106v8M6 60h8M106 60h8" /></g>
                <g transform={`rotate(${perf.rotation} 60 60)`}><path d="M60 60V16" style={{ stroke: "var(--ac)" }} strokeWidth="4" strokeLinecap="round" /></g>
                <circle cx="60" cy="60" r="6" style={{ fill: "var(--tx)" }} />
              </svg>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <div className="row plain" style={{ minHeight: 40, gap: 12 }}>
                  <span style={{ flex: "none" }}>Rotation</span>
                  <div style={{ flex: 1, minWidth: 30 }}>
                    <Slider label="Rotation" width="100%" min={-30} max={30} step={0.5} value={perf.rotation} onChange={(v) => updatePerf((p) => ({ ...p, rotation: v }))} />
                  </div>
                  <span className="num" style={{ color: "var(--act)", width: 44, textAlign: "right", flex: "none" }}>{perf.rotation}°</span>
                </div>
                <div className="row plain" style={{ minHeight: 40, gap: 12 }}>
                  <span style={{ flex: "none" }}>Vertical ratio</span>
                  <div style={{ flex: 1, minWidth: 30 }}>
                    <Slider label="Vertical ratio" width="100%" min={0.25} max={2} step={0.05} value={perf.y_ratio} onChange={(v) => updatePerf((p) => ({ ...p, y_ratio: v }))} />
                  </div>
                  <span className="num" style={{ width: 44, textAlign: "right", flex: "none" }}>{perf.y_ratio.toFixed(2)}</span>
                </div>
                <div className="row plain" style={{ minHeight: 40 }}>
                  <span>Curve per axis</span>
                  <Toggle label="Curve per axis" on={accel.per_axis} onChange={(v) => update((a) => ({ ...a, per_axis: v }))} />
                </div>
                <div className="row plain" style={{ minHeight: 40 }}>
                  <span>Output DPI</span>
                  <span className="num sub">{perf.native_dpi}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
