import { useEffect, useMemo, useState } from "react";
import { wirelessMouse } from "./models/wireless-mouse";
import { deviceLabel } from "./presets";
import { ThemeButton } from "./ui";
import type { EngineState } from "./engine";

const STANDARD: { id: number; label: string }[] = [
  { id: 1, label: "Left click" },
  { id: 2, label: "Right click" },
  { id: 3, label: "Wheel click" },
  { id: 4, label: "Side back" },
  { id: 5, label: "Side forward" },
];

interface Props {
  engine: EngineState;
  onDone(): void;
  onCalibrate(): void;
  onRequestSupport(): void;
}

/** First-launch guide: press every button once so the app knows how many the mouse has. */
export function Setup({ engine, onDone, onCalibrate, onRequestSupport }: Props) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [seen, setSeen] = useState<ReadonlySet<number>>(new Set());
  const [names, setNames] = useState<Record<number, string>>({});
  const device = engine.devices[0];

  // Listen for unknown buttons only while the detection step is showing.
  useEffect(() => {
    if (step !== 1 || !engine.connected) return;
    engine.learnStart(true);
    return () => engine.learnCancel();
    // learnStart/learnCancel are stable; the step and the connection are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, engine.connected]);

  // Everything held down during the detection step counts as found.
  useEffect(() => {
    if (step !== 1 || engine.pressed.size === 0) return;
    setSeen((prev) => {
      const next = new Set(prev);
      engine.pressed.forEach((b) => next.add(b));
      return next.size === prev.size ? prev : next;
    });
  }, [engine.pressed, step]);

  // Buttons the mouse is known to have (built in or learned earlier), plus what has turned up.
  const rows = useMemo(() => {
    const out = STANDARD.map((s) => ({ id: s.id, label: s.label, known: true }));
    const extras = (device?.extras ?? []).map((e) => ({ id: e.button, label: e.label, known: true }));
    for (const e of extras) if (!out.some((r) => r.id === e.id)) out.push(e);
    for (const s of seen) {
      if (s > 5 && !out.some((r) => r.id === s)) out.push({ id: s, label: wirelessMouse.buttons.find((b) => b.id === s)?.label ?? `Button ${s}`, known: true });
    }
    return out.sort((a, b) => a.id - b.id);
  }, [device, seen]);

  // Buttons that turned up but were never named are kept under a default name.
  const finishDetection = () => {
    engine.candidates.forEach((c) => engine.learnConfirm((names[c.button] ?? "").trim() || `Button ${c.button}`, c.button));
    setSeen((prev) => new Set([...prev, ...engine.candidates.map((c) => c.button)]));
    setStep(2);
  };

  const found = rows.filter((r) => seen.has(r.id));
  const total = found.length + engine.candidates.length;
  const missing = rows.filter((r) => !seen.has(r.id));

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 50, display: "flex", flexDirection: "column", padding: "28px 32px", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="logo" style={{ marginBottom: 0 }}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 3v7" /></svg>
          </div>
          <b style={{ fontSize: 16 }}>Kinetic setup</b>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="sub">Step {step + 1} of 3</span>
          <ThemeButton />
          <button type="button" className="btn2" onClick={onDone}>Skip for now</button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 0" }}>
        <div className="card" style={{ width: "min(900px, 100%)", padding: 32, display: "flex", flexDirection: "column", gap: 18 }}>
          {step === 0 && (
            <>
              <h1 className="h1">Let's get to know your mouse</h1>
              <div className="sub" style={{ fontSize: 15, lineHeight: 1.5 }}>
                Kinetic needs to know how many buttons your mouse has. It takes about a minute: you press each button once,
                one at a time, and we tick them off. Nothing is changed on your mouse.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className={`dot ${engine.connected ? "ok" : "warn"}`} />
                <span>
                  {engine.connected
                    ? device
                      ? `Found ${deviceLabel(device)}. Windows reports ${device.buttons} buttons.`
                      : "The engine is running, but no mouse was found yet."
                    : "Starting the engine… this can take a few seconds."}
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button className="btn" type="button" disabled={!engine.connected} onClick={() => setStep(1)}>Start</button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1 className="h1">Press every button once</h1>
              <div className="sub" style={{ fontSize: 15, lineHeight: 1.5 }}>
                One at a time: the left and right buttons, the wheel click, the side buttons, the DPI button and any
                thumb or top buttons. Each one ticks off below when it is detected. The scroll wheel and tilt are not buttons.
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }} aria-live="polite">
                {rows.map((r) => {
                  const ok = seen.has(r.id);
                  return (
                    <div
                      key={r.id}
                      className="row plain"
                      style={{
                        height: 56, padding: "0 14px", borderRadius: 12, cursor: "default",
                        background: ok ? "var(--oks)" : "var(--sub)", boxShadow: ok ? "inset 0 0 0 1px var(--ok)" : "none",
                      }}
                    >
                      <span><b className="nb">{r.id}</b>{r.label}</span>
                      <span style={{ color: ok ? "var(--ok)" : "var(--mu)", fontSize: 12, fontWeight: 600 }}>{ok ? "✓ Found" : "Waiting"}</span>
                    </div>
                  );
                })}
              </div>

              {engine.candidates.map((c) => (
                <form
                  key={c.button}
                  style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 14px", borderRadius: 12, background: "var(--acs)", border: "1px solid var(--ac)" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const label = (names[c.button] ?? "").trim() || `Button ${c.button}`;
                    engine.learnConfirm(label, c.button);
                    setSeen((prev) => new Set(prev).add(c.button));
                  }}
                >
                  <b>New button found</b>
                  <span className="sub">It will be button {c.button}. Name it:</span>
                  <input
                    className="input"
                    aria-label={`Name for button ${c.button}`}
                    value={names[c.button] ?? ""}
                    maxLength={40}
                    placeholder="for example Thumb grid"
                    onChange={(e) => setNames((n) => ({ ...n, [c.button]: e.target.value }))}
                  />
                  <button className="btn" type="submit" style={{ height: 38 }}>Add</button>
                </form>
              ))}

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
                <span className="num" style={{ fontSize: 28 }}>{total}</span>
                <span className="sub">button{total === 1 ? "" : "s"} found so far</span>
                <span style={{ flex: 1 }} />
                <button className="btn2" type="button" onClick={() => setStep(0)}>Back</button>
                <button className="btn" type="button" onClick={finishDetection}>{total > 0 ? "That's all of them" : "Continue"}</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="h1">{total} button{total === 1 ? "" : "s"} detected</h1>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {found.map((r) => <span key={r.id} className="chip on"><b className="num" style={{ marginRight: 8 }}>{r.id}</b>{r.label}</span>)}
              </div>
              {missing.length > 0 && (
                <div className="sub" style={{ lineHeight: 1.5 }}>
                  Not pressed: {missing.map((r) => r.label).join(", ")}. That's fine if your mouse doesn't have them.
                  You can run this guide again from Settings.
                </div>
              )}
              <div className="sub" style={{ lineHeight: 1.5 }}>
                Next: the Buttons screen shows your mouse so you can give each button an action, and Performance sets DPI and polling rate.
              </div>
              <div className="sub" style={{ lineHeight: 1.5 }}>
                Windows can't tell the app your mouse's DPI. Calibrate it once and the app follows every press of the DPI button.
                If your mouse isn't fully supported, you can ask for it to be added.
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                <button className="btn2" type="button" onClick={onCalibrate}>Calibrate DPI stages</button>
                <button className="btn2" type="button" onClick={onRequestSupport}>Request support for this mouse</button>
                <span style={{ flex: 1 }} />
                <button className="btn2" type="button" onClick={() => setStep(1)}>Detect more</button>
                <button className="btn" type="button" onClick={onDone}>Finish</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
