import { useEffect, useState } from "react";
import type { EngineState } from "./engine";

/**
 * The window's own title bar, in place of the system one. It is see-through, so it takes the page's
 * colour, and holds the engine's Start and Stop button and the window buttons.
 */
export function TitleBar({ engine }: { engine: EngineState }) {
  const win = window.kinetic?.win;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win?.isMaximized().then(setMaximized).catch(() => {});
    return win?.onMaximized(setMaximized);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { connected, starting, engineMissing } = engine;
  const label = connected ? "Engine running" : starting ? "Starting the engine…" : engineMissing ? "Engine not found" : "Engine stopped";
  const canControl = !!window.kinetic?.engine;

  return (
    <header className="titlebar">
      <div className="tb-drag" />
      <div className="tb-engine" role="group" aria-label="Engine">
        <span className={`dot ${connected ? "ok" : starting ? "warn" : ""}`} aria-hidden="true" />
        <span role="status">{label}</span>
        {connected ? (
          <button type="button" className="tb-btn" onClick={engine.stopEngine} disabled={!canControl} title="Stops the engine and puts your mouse back to normal">Stop</button>
        ) : (
          <button type="button" className="tb-btn primary" onClick={engine.startEngine} disabled={!canControl || starting || engineMissing}>
            {starting ? "Starting…" : "Start engine"}
          </button>
        )}
      </div>
      {win && (
        <div className="tb-controls">
          <button type="button" className="wc" aria-label="Minimise" title="Minimise" onClick={() => win.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
          </button>
          <button type="button" className="wc" aria-label={maximized ? "Restore" : "Maximise"} title={maximized ? "Restore" : "Maximise"} onClick={() => win.toggleMaximize()}>
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
            )}
          </button>
          <button type="button" className="wc close" aria-label="Close" title="Close" onClick={() => win.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
          </button>
        </div>
      )}
    </header>
  );
}
