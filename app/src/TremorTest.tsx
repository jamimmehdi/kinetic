import { useEffect } from "react";
import type { EngineState, Steady, TremorResult } from "./engine";

const SECONDS = 10;

const LEVEL_TEXT: Record<TremorResult["level"], string> = {
  none: "No shaking detected. Your hand is steady enough that you may not need these settings.",
  light: "A little shaking. A light precision zone is enough.",
  medium: "Clear shaking. A medium precision zone and some speed smoothing should help.",
  strong: "Strong shaking. A strong precision zone should help. Pointer smoothing is not suggested because it adds delay.",
};

interface Props {
  engine: EngineState;
  /** Called with the settings to apply when the user accepts the suggestion. */
  onApply(change: Partial<Steady>): void;
  onClose(): void;
}

/** Hold-still test: the engine measures the tiny movements of a resting hand and suggests settings. */
export function TremorTest({ engine, onApply, onClose }: Props) {
  const t = engine.tremor;
  // Never leave the engine recording when the dialog goes away.
  useEffect(() => () => engine.tremorCancel(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    engine.tremorCancel();
    onClose();
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Test my hand" style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: "min(580px, 92vw)", padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 650, margin: 0 }}>Test my hand</h2>

        {t.state === "idle" && (
          <>
            <div className="sub" style={{ lineHeight: 1.5 }}>
              Rest your hand on the mouse the way you do when you play, and try to keep it as still as you can for {SECONDS} seconds. Do not click or move on purpose.
              Kinetic measures the tiny movements the sensor still reports, which is hand tremor, and suggests settings that calm it.
              Only mouse movement is measured, and nothing is saved or sent.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn2" onClick={close}>Cancel</button>
              <button type="button" className="btn" onClick={() => engine.tremorStart(SECONDS)}>Start the test</button>
            </div>
          </>
        )}

        {t.state === "running" && (
          <>
            <div className="sub">
              Hold still. {(() => {
                const left = Math.max(0, Math.ceil((t.seconds * 1000 - t.elapsed_ms) / 1000));
                return `${left} second${left === 1 ? "" : "s"} left.`;
              })()}
            </div>
            <div className="trk" style={{ width: "100%", cursor: "default", height: 8 }} role="progressbar" aria-valuenow={Math.round((t.elapsed_ms / (t.seconds * 1000)) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span className="fil" style={{ width: `${Math.min(100, (t.elapsed_ms / (t.seconds * 1000)) * 100)}%` }} />
            </div>
            <div className="num sub" aria-live="polite">{t.events} movements recorded</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn2" onClick={() => engine.tremorCancel()}>Cancel</button>
            </div>
          </>
        )}

        {t.state === "done" && (
          <>
            <div style={{ lineHeight: 1.5 }}>{LEVEL_TEXT[t.level]}</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="stat"><div className="num" style={{ fontSize: 22 }}>{t.rms_mm.toFixed(2)} <span style={{ fontSize: 12 }}>mm</span></div><div className="sub">Size of shaking</div></div>
              <div className="stat"><div className="num" style={{ fontSize: 22 }}>{t.dominant_hz > 0 ? t.dominant_hz.toFixed(1) : "–"} <span style={{ fontSize: 12 }}>Hz</span></div><div className="sub">Main rhythm</div></div>
              <div className="stat"><div className="num" style={{ fontSize: 22 }}>{t.peak_speed.toFixed(2)}</div><div className="sub">Peak speed, counts/ms</div></div>
            </div>
            {t.suggestion.precision && (
              <div className="sub" style={{ lineHeight: 1.5 }}>
                Suggested: precision zone below {t.suggestion.precision_below} counts/ms at {Math.round((t.suggestion.precision_factor ?? 1) * 100)}% sensitivity, with speed smoothing {t.suggestion.speed_smoothing}.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className="btn2" onClick={() => engine.tremorStart(SECONDS)}>Test again</button>
              <button type="button" className="btn2" onClick={close}>Close</button>
              {t.suggestion.precision && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onApply({
                      precision: true,
                      precision_below: t.suggestion.precision_below,
                      precision_factor: t.suggestion.precision_factor,
                      speed_smoothing: t.suggestion.speed_smoothing,
                    });
                    close();
                  }}
                >
                  Apply the suggestion
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
