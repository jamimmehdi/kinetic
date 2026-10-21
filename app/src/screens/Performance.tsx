import { useState } from "react";
import { MeasureDpi } from "../MeasureDpi";
import { Dial, Slider, Tag, Toggle, Top } from "../ui";
import { getProfile, stageDpi, withProfile, type EngineState, type Perf } from "../engine";

const RATES_TOP = [125, 250, 500, 1000];
const RATES_BOTTOM = [2000, 4000, 8000];
const MAX_STAGES = 8;
/** One-click DPI values under the dials. */
const PRESETS = [400, 800, 1200, 1600, 2000, 2400, 3200, 4000];
/** A new stage goes one 400-step above the highest existing one. */
const nextStageDpi = (dpis: number[]) => Math.min(32000, (Math.floor(Math.max(...dpis, 0) / 400) + 1) * 400);

interface Props {
  engine: EngineState;
  profileId: string;
  onProfileChange(id: string): void;
}

export function PerformanceScreen({ engine, profileId, onProfileChange }: Props) {
  const { config, telemetry, hardware } = engine;
  const hw = hardware?.connected ? hardware : null;
  const profile = getProfile(config, profileId);
  const perf = profile.perf;
  // For the profile that is active right now, show what the mouse is really doing: the stage the
  // buttons (or the mouse's own DPI button) picked, not just the one saved in the profile.
  const [measuring, setMeasuring] = useState(false);
  const live = profile.id === engine.activeProfile ? engine.dpi : null;
  const stage = Math.min(live && !live.custom ? live.stage : perf.active_stage, perf.stages.length - 1);
  const [dx, dy] = live ? [live.dpi_x, live.dpi_y] : stageDpi(perf, stage);
  const maxDial = Math.max(3200, ...perf.stages.map((s) => s.dpi));

  const update = (change: (p: Perf) => Perf) =>
    engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, perf: change(p.perf) })));

  const setStageValue = (change: (s: Perf["stages"][number]) => Perf["stages"][number]) =>
    update((p) => ({ ...p, stages: p.stages.map((s, i) => (i === stage ? change(s) : s)) }));

  const setX = (v: number) => setStageValue((s) => ({ ...s, dpi: v }));
  const setY = (v: number) =>
    update((p) => ({
      ...p,
      independent_xy: true,
      // Turning independence on keeps the other stages' vertical DPI equal to their horizontal one.
      stages: p.stages.map((s, i) => (i === stage ? { ...s, dpi_y: v } : { ...s, dpi_y: s.dpi_y ?? s.dpi })),
    }));
  const setIndependent = (on: boolean) =>
    update((p) => ({ ...p, independent_xy: on, stages: p.stages.map((s) => ({ ...s, dpi_y: on ? s.dpi_y ?? s.dpi : null })) }));

  const addStage = () =>
    update((p) => (p.stages.length >= MAX_STAGES ? p : { ...p, stages: [...p.stages, { dpi: nextStageDpi(p.stages.map((s) => s.dpi)), dpi_y: null }] }));
  const removeStage = () =>
    update((p) =>
      p.stages.length <= 1
        ? p
        : { ...p, stages: p.stages.filter((_, i) => i !== stage), active_stage: Math.max(0, Math.min(stage, p.stages.length - 2)) },
    );

  // The polling-rate button closest to what the mouse is actually doing.
  const measured = telemetry && telemetry.hz > 0 ? telemetry.hz : 0;
  const all = [...RATES_TOP, ...RATES_BOTTOM];
  const nearest = measured ? all.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a)) : 0;

  return (
    <>
      <Top title="Performance" sub={`Sensitivity, polling and pointer feel for the ${profile.name} profile.`}>
        <label className="sub" htmlFor="profile-pick">Profile</label>
        <select id="profile-pick" className="input select" value={profile.id} onChange={(e) => onProfileChange(e.target.value)}>
          {config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="pill"><span className="dot ok" />Any mouse</span>
        <span className="pill"><span className="dot warn" />Supported devices only</span>
      </Top>

      <div className="grid12" style={{ gridTemplateRows: "minmax(0,1.25fr) minmax(0,1fr)" }}>
        <div className="card" style={{ gridColumn: "span 7", padding: "22px 26px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span className="lbl">Sensitivity</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }} role="group" aria-label="DPI stage being edited">
              {perf.stages.map((_, i) => (
                <button key={i} type="button" className={`chip small ${i === stage && !live?.custom ? "on" : ""}`} style={{ cursor: "pointer", padding: "0 10px" }} aria-pressed={i === stage && !live?.custom} title={`${perf.stages[i].dpi} DPI`} onClick={() => { update((p) => ({ ...p, active_stage: i })); engine.setStage(i); }}>
                  {i + 1}
                </button>
              ))}
              <button type="button" className="icon-btn" aria-label="Add a stage" disabled={perf.stages.length >= MAX_STAGES} onClick={addStage}>＋</button>
              <button type="button" className="icon-btn" aria-label="Remove this stage" disabled={perf.stages.length <= 1} onClick={removeStage}>－</button>
              <Tag kind="all">Any mouse</Tag>
            </div>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
            <div style={{ textAlign: "center" }}>
              <Dial label="X axis" value={dx} max={maxDial} onChange={setX} />
              <div style={{ fontWeight: 600, marginTop: 2 }}>X axis</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <Toggle label="Independent X and Y" on={perf.independent_xy} onChange={setIndependent} />
              <span className="sub" style={{ fontSize: 12 }}>Independent</span>
            </div>
            <div style={{ textAlign: "center" }}>
              <Dial label="Y axis" value={dy} max={maxDial} onChange={setY} />
              <div style={{ fontWeight: 600, marginTop: 2 }}>Y axis</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexWrap: "wrap", marginBottom: 14, marginTop: 4 }} role="group" aria-label="DPI presets">
            <span className="sub" style={{ marginRight: 6 }}>Presets</span>
            {PRESETS.map((v) => (
              <button key={v} type="button" className={`chip small num ${dx === v ? "on" : ""}`} style={{ cursor: "pointer" }} aria-pressed={dx === v} onClick={() => setX(v)}>
                {v}
              </button>
            ))}
          </div>
          {hw ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
              <Toggle label="Set the mouse's own DPI" on={perf.use_hardware} onChange={(v) => update((p) => ({ ...p, use_hardware: v }))} />
              <span>Set the mouse's own DPI</span>
              <span className="sub">
                {perf.use_hardware
                  ? `The ${hw.vendor} mouse runs at the stage's DPI itself. It reports ${hw.dpi_x ?? "?"} DPI now.`
                  : `Stages are scaled in software from the ${hw.dpi_x ?? "?"} DPI the mouse reports.`}
              </span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <label className="sub" htmlFor="native-dpi">Your mouse's own DPI is set to</label>
              <input
                id="native-dpi"
                className="input narrow num"
                type="number"
                min={50}
                max={32000}
                step={50}
                value={perf.native_dpi}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 50) update((p) => ({ ...p, native_dpi: Math.min(32000, Math.round(n)) }));
                }}
              />
              <button type="button" className="btn2" onClick={() => setMeasuring(true)}>Measure it</button>
              <span className="sub">Stages are worked out from this. Not sure? Measure it.</span>
            </div>
          )}
        </div>

        <div className="card" style={{ gridColumn: "span 5", padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="lbl">Polling rate</span>
            {hw?.can_set_polling ? <Tag kind="all">{hw.vendor} · supported</Tag> : <Tag kind="dev">Supported devices</Tag>}
          </div>
          {[RATES_TOP, RATES_BOTTOM].map((group, gi) => (
            <div key={gi} style={{ display: "flex", gap: 6 }} role="group" aria-label={hw?.can_set_polling ? "Polling rate" : "Polling rates, read only"}>
              {group.map((r) => {
                const settable = !!hw?.can_set_polling && hw.polling_options.includes(r);
                const current = hw?.can_set_polling ? hw.polling_hz === r : r === nearest;
                return (
                  <button
                    key={r}
                    type="button"
                    className="num"
                    disabled={!settable}
                    aria-pressed={current}
                    onClick={() => engine.setPolling(r)}
                    style={{
                      flex: 1, height: 42, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10, fontSize: 14, border: 0,
                      cursor: settable ? "pointer" : "default", opacity: hw?.can_set_polling && !settable ? 0.4 : 1,
                      background: current ? "var(--ac)" : "var(--sub)", color: current ? "#fff" : "var(--mu)",
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 18, marginTop: 2 }}>
            <div>
              <div className="num" style={{ fontSize: 36, lineHeight: 1, color: "var(--act)" }}>
                {measured || "–"} <span style={{ fontSize: 15 }}>Hz</span>
              </div>
              <div className="sub" style={{ marginTop: 6 }}>Measured now</div>
            </div>
            <div className="sub" style={{ flex: 1, fontSize: 12 }}>
              {hw?.can_set_polling
                ? `Set on the mouse itself. This mouse allows ${hw.polling_options.join(", ")} Hz.`
                : "This mouse isn't on the supported list yet, so the rate is read-only. Move the mouse to measure it."}
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "span 4", padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span className="lbl">Pointer feel</span>
            <Tag kind="all">Any mouse</Tag>
          </div>
          <div className="row plain"><span>Raw 1:1 movement</span><Toggle label="Raw 1:1 movement" on={perf.raw_movement} onChange={(v) => update((p) => ({ ...p, raw_movement: v }))} /></div>
          <div className="row plain"><span>Angle snapping</span><Toggle label="Angle snapping" on={perf.angle_snap} onChange={(v) => update((p) => ({ ...p, angle_snap: v }))} /></div>
          <div className="row plain">
            <span>Smoothing</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* Half of a sudden move is still held back after this long, at a 1000 Hz mouse. */}
              <span className="sub num" style={{ fontSize: 12, minWidth: 52, textAlign: "right" }} title="How long smoothing takes to catch up halfway">
                {perf.smoothing > 0.001 ? `≈ ${(Math.log(0.5) / Math.log(perf.smoothing)).toFixed(1)} ms` : "off"}
              </span>
              <Slider label="Smoothing" width={120} min={0} max={0.98} step={0.01} value={perf.smoothing} onChange={(v) => update((p) => ({ ...p, smoothing: v }))} />
            </span>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "span 4", padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span className="lbl">Scroll</span>
            <Tag kind="all">Any mouse</Tag>
          </div>
          <div className="row plain">
            <span>Lines per notch</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button type="button" className="icon-btn" aria-label="Fewer lines" disabled={perf.scroll.lines <= 1} onClick={() => update((p) => ({ ...p, scroll: { ...p.scroll, lines: p.scroll.lines - 1 } }))}>－</button>
              <span className="num" style={{ minWidth: 20, textAlign: "center" }}>{perf.scroll.lines}</span>
              <button type="button" className="icon-btn" aria-label="More lines" disabled={perf.scroll.lines >= 100} onClick={() => update((p) => ({ ...p, scroll: { ...p.scroll, lines: p.scroll.lines + 1 } }))}>＋</button>
            </span>
          </div>
          <div className="row plain"><span>Smooth scrolling</span><Toggle label="Smooth scrolling" on={perf.scroll.smooth} onChange={(v) => update((p) => ({ ...p, scroll: { ...p.scroll, smooth: v } }))} /></div>
          <div className="row plain"><span>Reverse direction</span><Toggle label="Reverse scroll direction" on={perf.scroll.reverse} onChange={(v) => update((p) => ({ ...p, scroll: { ...p.scroll, reverse: v } }))} /></div>
        </div>

        <div className="card" style={{ gridColumn: "span 4", padding: "20px 22px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span className="lbl">Sensor tuning</span>
            <Tag kind="dev">Locked on this mouse</Tag>
          </div>
          <div className="row plain" style={{ opacity: 0.45 }}><span>Lift-off distance</span><span className="num">1 mm</span></div>
          <div className="row plain" style={{ opacity: 0.45 }}><span>Motion sync</span><Toggle label="Motion sync" on={false} disabled onChange={() => {}} /></div>
          <div className="row plain" style={{ opacity: 0.45 }}><span>Surface calibration</span><span className="sub">Calibrate</span></div>
        </div>
      </div>
      {measuring && (
        <MeasureDpi engine={engine} onClose={() => setMeasuring(false)} onApply={(dpi) => update((p) => ({ ...p, native_dpi: Math.min(32000, dpi) }))} />
      )}
    </>
  );
}
