import { useEffect, useRef, useState } from "react";
import { deviceLabel } from "./presets";
import type { DeviceInfo, EngineState } from "./engine";
import type { DpiCalibration } from "./deviceDpi";

const CM = 10;
/** A measured stage this close to the first one means the DPI button has wrapped round. */
const SAME = 0.1;

interface Props {
  engine: EngineState;
  onSave(device: DeviceInfo, cal: DpiCalibration): void;
  onClose(): void;
}

type Step = "button" | "measure";

/** Learns the mouse's DPI button and the DPI of each stage by measuring them one at a time. */
export function DpiCalibrate({ engine, onSave, onClose }: Props) {
  const [step, setStep] = useState<Step>("button");
  const [target, setTarget] = useState<{ device: DeviceInfo; button: number | null } | null>(null);
  const [stages, setStages] = useState<number[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState("");
  const m = engine.measure;
  const seen = useRef(engine.lastButton?.n ?? 0);
  const handled = useRef(false);

  useEffect(() => () => engine.measureCancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 1: the next button press that is not a plain click is the DPI button.
  useEffect(() => {
    const e = engine.lastButton;
    if (step !== "button" || !e || !e.down || e.n <= seen.current || e.button <= 2) return;
    const device = engine.devices.find((d) => d.id === e.device);
    if (device) {
      setTarget({ device, button: e.button });
      setStep("measure");
    }
  }, [engine.lastButton?.n, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // A measurement that has finished is added as a stage, or ends the loop when it wraps round.
  useEffect(() => {
    if (step !== "measure" || m.state !== "done" || handled.current || !target) return;
    handled.current = true;
    if (m.device !== target.device.id) {
      setNote("That movement came from a different mouse. Measure again with the mouse you are setting up.");
      return;
    }
    setNote("");
    if (stages.length > 0 && Math.abs(m.dpi - stages[0]) <= stages[0] * SAME) {
      finish(stages);
      return;
    }
    const next = [...stages, m.dpi];
    setStages(next);
    if (target.button !== null) setWaiting(true);
  }, [m.state, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a stage, pressing the DPI button again starts the next measurement.
  useEffect(() => {
    const e = engine.lastButton;
    if (!waiting || !target || !e || !e.down || e.n <= seen.current) return;
    if (e.device === target.device.id && e.button === target.button) {
      setWaiting(false);
      begin();
    }
  }, [engine.lastButton?.n, waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (engine.lastButton) seen.current = engine.lastButton.n;
  }, [engine.lastButton?.n]);

  const begin = () => {
    handled.current = false;
    engine.measureStart(CM);
  };

  const finish = (list: number[]) => {
    if (target && list.length > 0) onSave(target.device, { button: target.button, stages: list });
    onClose();
  };

  const running = m.state === "running";
  return (
    <div role="dialog" aria-modal="true" aria-label="Calibrate DPI stages" style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: "min(600px, 92vw)", padding: 28, display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ fontSize: 20, fontWeight: 650, margin: 0 }}>Calibrate DPI stages</h2>

        {step === "button" && (
          <>
            <div className="sub" style={{ lineHeight: 1.5 }}>
              Press the DPI button on your mouse once. It's the one that cycles the mouse's own DPI, often behind the wheel or on top.
              The app learns it so it can follow every change from then on.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className="btn2" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn2"
                disabled={!engine.devices[0]}
                onClick={() => { setTarget({ device: engine.devices[0], button: null }); setStep("measure"); }}
              >
                Nothing happened, or no DPI button
              </button>
            </div>
          </>
        )}

        {step === "measure" && target && (
          <>
            <div className="sub" style={{ lineHeight: 1.5 }}>
              {deviceLabel(target.device)}
              {target.button !== null ? ` · DPI button is button ${target.button}.` : " · measuring the current DPI only."}
              {" "}Put a ruler on the desk. Press Measure, move the mouse {CM} cm in a straight line, then press Done.
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} aria-label="Stages measured so far">
              {stages.map((d, i) => <span key={i} className="chip on"><b className="num" style={{ marginRight: 8 }}>{i + 1}</b>{d} DPI</span>)}
            </div>

            {note && <div role="alert" style={{ color: "var(--wn)" }}>{note}</div>}

            {running && (
              <div className="num" style={{ fontSize: 36 }} aria-live="polite">{m.counts} <span className="sub" style={{ fontSize: 14 }}>counts</span></div>
            )}
            {waiting && !running && (
              <div style={{ color: "var(--act)" }}>
                Stage {stages.length} is {stages[stages.length - 1]} DPI. Press the DPI button on the mouse to go to the next stage,
                or finish if it has gone all the way round.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className="btn2" onClick={onClose}>Cancel</button>
              {stages.length > 0 && !running && <button type="button" className="btn2" onClick={() => finish(stages)}>Finish with {stages.length} stage{stages.length === 1 ? "" : "s"}</button>}
              {running
                ? <button type="button" className="btn" onClick={() => engine.measureFinish()}>Done</button>
                : <button type="button" className="btn" onClick={() => { setWaiting(false); begin(); }}>{stages.length === 0 ? "Measure" : "Measure the next stage"}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
