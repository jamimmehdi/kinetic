import { useEffect, useState } from "react";
import type { EngineState } from "./engine";

const DISTANCES = [5, 10, 20];

interface Props {
  engine: EngineState;
  /** Called with the measured DPI when the user accepts it. */
  onApply(dpi: number): void;
  onClose(): void;
}

/** Windows never reports a mouse's DPI, so we measure it: move the mouse a known distance. */
export function MeasureDpi({ engine, onApply, onClose }: Props) {
  const [cm, setCm] = useState(10);
  const m = engine.measure;
  const running = m.state === "running";

  // Never leave the engine counting when the dialog goes away.
  useEffect(() => () => engine.measureCancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { engine.measureCancel(); onClose(); };

  return (
    <div role="dialog" aria-modal="true" aria-label="Measure DPI" style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: "min(560px, 92vw)", padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 650, margin: 0 }}>Measure your mouse's DPI</h2>

        {(m.state === "idle" || m.state === "failed") && (
          <>
            <div className="sub" style={{ lineHeight: 1.5 }}>
              Put a ruler on the desk. Press Start, move the mouse in a straight line along exactly the distance you pick,
              then press Done. The app counts what the sensor sent and works out the DPI. Do it again after changing DPI on the mouse.
            </div>
            {m.state === "failed" && <div role="alert" style={{ color: "var(--wn)" }}>No movement was detected. Try again and move the mouse.</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }} role="group" aria-label="Distance to move">
              <span className="sub">Distance</span>
              {DISTANCES.map((d) => (
                <button key={d} type="button" className={`chip small num ${cm === d ? "on" : ""}`} style={{ cursor: "pointer" }} aria-pressed={cm === d} onClick={() => setCm(d)}>{d} cm</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn2" onClick={close}>Cancel</button>
              <button type="button" className="btn" onClick={() => engine.measureStart(cm)}>Start</button>
            </div>
          </>
        )}

        {running && (
          <>
            <div className="sub">Move the mouse {m.cm} cm in a straight line, then press Done.</div>
            <div className="num" style={{ fontSize: 40 }} aria-live="polite">{m.counts} <span className="sub" style={{ fontSize: 14 }}>counts</span></div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn2" onClick={() => engine.measureCancel()}>Cancel</button>
              <button type="button" className="btn" onClick={() => engine.measureFinish()}>Done</button>
            </div>
          </>
        )}

        {m.state === "done" && (
          <>
            <div className="num" style={{ fontSize: 48, color: "var(--act)" }}>{m.dpi} <span style={{ fontSize: 16 }}>DPI</span></div>
            <div className="sub">Counted {m.counts} over {m.cm} cm. Sensors are rarely exact, so this can be a little off the number printed on the mouse.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn2" onClick={() => engine.measureStart(m.cm)}>Measure again</button>
              <button type="button" className="btn2" onClick={close}>Close</button>
              <button type="button" className="btn" onClick={() => { onApply(m.dpi); close(); }}>Use {m.dpi} as my mouse's DPI</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
