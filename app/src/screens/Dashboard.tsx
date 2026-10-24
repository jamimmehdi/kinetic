import { useMemo } from "react";
import { useDeviceDpiContext } from "../deviceDpi";
import { wirelessMouse } from "../models/wireless-mouse";
import { deviceLabel } from "../presets";
import { avatarColor, Pill, Tag, Toggle, Top } from "../ui";
import { DEFAULT_PROFILE, getProfile, stageDpi, type EngineState } from "../engine";

const LABELS = ["Stage 1", "Stage 2", "Stage 3", "Stage 4", "Stage 5", "Stage 6", "Stage 7", "Stage 8"];

export function DashboardScreen({ engine }: { engine: EngineState }) {
  const { config, telemetry, dpi, hardware } = engine;
  const hw = hardware?.connected ? hardware : null;
  const tracked = useDeviceDpiContext()?.tracked ?? null;
  const active = getProfile(config, engine.activeProfile);
  const perf = active.perf;
  const device = engine.devices[0];

  const stage = dpi?.stage ?? perf.active_stage;
  const [dx, dy] = dpi ? [dpi.dpi_x, dpi.dpi_y] : stageDpi(perf, stage);
  const maxDpi = Math.max(...perf.stages.map((s) => s.dpi), 1);

  // Which button cycles DPI and which one is the Shift button, from the base layer of this profile
  // (or the Default profile, which fills in anything this one leaves unmapped).
  const base = [...active.mappings, ...getProfile(config, DEFAULT_PROFILE).mappings];
  const dpiKey = base.find((m) => m.action.type === "dpi" && (m.action.op === "cycle" || m.action.op === "up"));
  const shiftKey = base.find((m) => m.action.type === "shift");
  const holdStages = new Set(base.filter((m) => m.action.type === "dpi" && m.action.op === "hold").map((m) => (m.action.type === "dpi" ? m.action.stage : -1)));

  const linked = config.profiles.filter((p) => p.app);
  const runningName = [...engine.runningMacros].map((id) => config.macros.find((m) => m.id === id)?.name).find(Boolean);

  const graph = useMemo(() => {
    const h = engine.speedHistory;
    const peak = Math.max(4, ...h);
    const pts = h.map((v, i) => `${(i / (h.length - 1)) * 400},${96 - (v / peak) * 88}`);
    return { line: `M${pts.join(" L")}`, area: `M0,100 L${pts.join(" L")} L400,100 Z` };
  }, [engine.speedHistory]);

  return (
    <>
      <Top
        title="Dashboard"
        sub={
          engine.activeApp
            ? `${engine.activeApp} is in front, so your ${active.name} profile is active.`
            : `Your ${active.name} profile is active.`
        }
      >
        <Pill tone={engine.connected ? "ok" : "warn"}>
          {engine.connected ? deviceLabel(device) : "Engine not running"}
        </Pill>
        <span className="pill">Profile · <b style={{ fontWeight: 600 }}>{active.name}</b></span>
        <button className="btn" type="button" title={engine.asideReason === "blocked" ? "Windows or another program is blocking the input Kinetic sends. It retries in a few seconds or when you switch windows." : engine.game ? "A game with anti-cheat is in front. Kinetic stays out of its way." : undefined} disabled={!engine.connected || engine.game} onClick={() => engine.setPaused(!engine.paused)}>
          {engine.game ? (engine.asideReason === "blocked" ? "Paused: input blocked" : "Paused for a game") : engine.paused ? "Resume engine" : "Pause engine"}
        </button>
      </Top>

      <div className="grid12" style={{ gridTemplateRows: "minmax(0,1.5fr) minmax(0,1fr)" }}>
        <div className="card" style={{ gridColumn: "span 7", position: "relative", overflow: "hidden", padding: "24px 28px" }}>
          {/* Cropped to the drawing and sized by the card, so it stays inside at any window size. */}
          <svg
            viewBox="20 110 940 760"
            role="img"
            aria-label="Line drawing of a wireless mouse"
            style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)", height: "84%", maxHeight: 440, maxWidth: "min(50%, 340px)", width: "auto" }}
          >
            <path d={wirelessMouse.outline} fillRule="evenodd" style={{ fill: "var(--line)" }} />
          </svg>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="lbl">Live sensitivity</span>
              <Tag kind="all">Any mouse</Tag>
            </div>
            <div className="num" style={{ fontSize: 84, lineHeight: 1, marginTop: 14, letterSpacing: "-0.03em" }}>{tracked ? tracked.dpi : dx}</div>
            <div className="sub" style={{ marginTop: 8, maxWidth: "min(300px, 46%)" }}>
              {tracked
                ? `DPI · stage ${tracked.stage + 1} of ${tracked.stages} · ${tracked.dpi} (measured)`
                : dpi?.custom
                ? `DPI · set with the mouse's own button · X ${dx} / Y ${dy}`
                : `DPI · stage ${stage + 1} of ${perf.stages.length} · X ${dx} / Y ${dy}${hw && dpi?.hardware ? " · set on the mouse" : ""}`}
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 12 }}>
              <div className="stat">
                <div className="num" style={{ fontSize: 20 }}>
                  {hw?.polling_hz ?? (telemetry && telemetry.hz > 0 ? telemetry.hz : "–")}
                  <span style={{ fontSize: 13, color: "var(--mu)" }}> Hz</span>
                </div>
                <div className="sub" style={{ fontSize: 12 }}>{hw?.polling_hz ? "Polling, from the mouse" : "Polling, measured"}</div>
              </div>
              {hw?.battery != null && (
                <div className="stat">
                  <div className="num" style={{ fontSize: 20 }}>{hw.battery}<span style={{ fontSize: 13, color: "var(--mu)" }}> %</span></div>
                  <div className="sub" style={{ fontSize: 12 }}>Battery</div>
                </div>
              )}
              <div className="stat">
                <div className="num" style={{ fontSize: 20 }}>
                  {telemetry && telemetry.latency_ms > 0 ? telemetry.latency_ms.toFixed(1) : "–"}
                  <span style={{ fontSize: 13, color: "var(--mu)" }}> ms</span>
                </div>
                <div className="sub" style={{ fontSize: 12 }}>Engine latency</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "span 5", padding: 22, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="lbl">DPI stages</span>
            <span className="sub">{dpiKey ? `Hotkey · button ${dpiKey.button}` : "No hotkey set"}</span>
          </div>
          {perf.stages.map((s, i) => (
            <button key={i} type="button" className={`stage ${i === stage && !dpi?.custom ? "on" : ""}`} aria-pressed={i === stage && !dpi?.custom} onClick={() => engine.setStage(i)}>
              <span className="num" style={{ width: 52 }}>{s.dpi}</span>
              <div className="bar"><i style={{ width: `${(s.dpi / maxDpi) * 100}%` }} /></div>
              {i === stage && !dpi?.custom ? (
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--act)" }}>Active</span>
              ) : (
                <span className="sub">{holdStages.has(i) ? "Hold" : LABELS[i]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="card" style={{ gridColumn: "span 5", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="lbl">Pointer speed</span>
            <span className="sub">last 10 s</span>
          </div>
          <svg viewBox="0 0 400 100" width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label="Pointer speed over the last ten seconds" style={{ flex: 1, minHeight: 0 }}>
            <path d={graph.area} style={{ fill: "var(--acs)" }} />
            <path d={graph.line} fill="none" style={{ stroke: "var(--ac)" }} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>

        <div className="card" style={{ gridColumn: "span 3", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="lbl">Active layer</span>
          <div style={{ fontSize: 24, fontWeight: 650 }}>{engine.shiftActive ? "Shift" : "Base"}</div>
          <div className="sub">
            {shiftKey ? (
              <>Hold <b style={{ color: "var(--tx)" }}>button {shiftKey.button}</b> for the Shift layer.</>
            ) : (
              "Give a button the Layer shift action to use a second set of mappings."
            )}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="sub">Macro engine</span>
            <Tag kind="all">{runningName ? `Running · ${runningName}` : "Idle"}</Tag>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "span 4", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="lbl">Auto-switch</span>
            <Toggle label="Switch profiles automatically" on={config.auto_switch} onChange={(on) => engine.setConfig({ ...config, auto_switch: on })} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {linked.slice(0, 4).map((p) => (
              <span key={p.id} className="av small" title={`${p.name} · ${p.app}`} style={{ background: avatarColor(p.id) }}>
                {(p.name || "?").charAt(0).toUpperCase()}
              </span>
            ))}
            {linked.length > 4 && <span className="sub">+{linked.length - 4}</span>}
          </div>
          <div className="sub">
            {linked.length === 0
              ? "No apps linked yet. Link one on the Profiles screen."
              : `${linked.length} app${linked.length === 1 ? "" : "s"} linked. Profiles switch as you change windows.`}
          </div>
        </div>
      </div>
    </>
  );
}
