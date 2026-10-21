import { useContext, useEffect, useState } from "react";
import { ThemeContext, Toggle, Top } from "../ui";
import type { ActivityEntry, AppSettings, EngineState, UpdateStatus } from "../engine";

const ANY = [
  ["Global button remapping", "Low-level hooks, works in every app"],
  ["Shift layers (Hypershift style)", "Hold a button to unlock a second map"],
  ["Macro builder", "Keys, clicks, movement, ms delays, loops"],
  ["Per-app profile auto-switching", "Follows the foreground window"],
  ["DPI stages and independent X / Y", "Emulated by scaling movement in software"],
  ["Acceleration curves, rotation, smoothing, angle snapping", "Sigmoid, natural, power, drawn curves"],
  ["Scroll: lines per notch, smooth, reverse", "Applied while the profile is active"],
  ["Polling rate monitor", "Measures the real rate, read only"],
];
const DEVICE = [
  ["Razer mice: DPI, polling rate and battery", "Supported now, over Razer's own HID protocol"],
  ["Real hardware DPI", "Written to the sensor over HID"],
  ["Polling rate change", "125, 500 or 1000 Hz on the Razer mouse tested; other brands need their own module"],
  ["Idle polling ramp-down and sleep timers", ""],
  ["Lift-off distance and surface calibration", ""],
  ["Motion sync", ""],
  ["On-board profile and macro storage", "Keeps working without the app running"],
  ["Battery level", ""],
];
const NOT = [
  ["Changing polling rate on an unsupported mouse", "Fixed by firmware and the USB descriptor"],
  ["Lift-off, motion sync or surface tuning on a basic mouse", "The sensor has no such setting to reach"],
  ["Software DPI above the sensor's native count", "Scaling up cannot add real detail"],
  ["Reading the sensor's true DPI", "Windows never reports it"],
];

const KIND_LABEL: Record<string, string> = {
  app: "App in front", button: "Button", movement: "Movement", injected_input: "Sent input", scroll: "Scroll",
  dpi: "DPI stage", macro: "Macro", engine: "Engine", log: "Log",
};

/** One log line in plain words, with whether the thing worked (null when that is not a question). */
export function describeActivity(e: ActivityEntry): { text: string; worked: boolean | null } {
  const d = e.detail as Record<string, number | boolean | string | null>;
  switch (e.kind) {
    case "movement":
      return { text: `${d.sent} moves sent, ${d.delivered} arrived`, worked: !!d.worked };
    case "injected_input":
      return { text: `${d.accepted} accepted, ${d.refused} refused by Windows`, worked: !!d.worked };
    case "button":
      return { text: `Button ${d.button} ran a ${d.action} action`, worked: null };
    case "scroll":
      return { text: `${d.notches} scroll notch(es) changed`, worked: null };
    case "dpi":
      return { text: `Stage ${d.stage}`, worked: null };
    case "macro":
      return { text: `Macro ${d.id}`, worked: null };
    case "app":
      return { text: d.protected_game ? "Protected game in front" : "Now in front", worked: null };
    case "engine":
      return { text: d.stepped_aside ? `Stepped aside (${d.stepped_aside === "blocked" ? "input blocked" : "game"})` : "Active again", worked: d.stepped_aside ? false : true };
    default:
      return { text: String(d.state ?? ""), worked: null };
  }
}

function ActivityCard({ engine, on, disabled, onToggle }: { engine: EngineState; on: boolean; disabled: boolean; onToggle(v: boolean): void }) {
  const { activity } = engine;
  useEffect(() => { engine.requestActivity(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = activity.slice(-100).reverse();
  const checks = activity.filter((e) => describeActivity(e).worked !== null);
  const good = checks.filter((e) => describeActivity(e).worked).length;
  const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

  return (
    <div className="card" style={{ padding: "6px 22px", flex: "none" }}>
      <div className="row plain">
        <span>Activity log<span className="sub" style={{ display: "block", fontSize: 12 }}>Records what Kinetic does and whether Windows accepted it, so you can see if your settings worked in a game. It never records key names or typed text.</span></span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" className="btn2" onClick={() => window.kinetic?.showLog?.()} disabled={!window.kinetic?.showLog}>Show file</button>
          <button type="button" className="btn2" onClick={() => engine.clearActivity()} disabled={activity.length === 0}>Clear</button>
          <Toggle label="Record activity" on={on} disabled={disabled} onChange={onToggle} />
        </span>
      </div>
      {on && (
        <div style={{ borderTop: "1px solid var(--bd)", padding: "10px 0 14px" }}>
          <div className="sub" style={{ fontSize: 12, marginBottom: 8 }} role="status">
            {checks.length === 0 ? "Nothing to check yet. Use the mouse in your game, then come back." : `${good} of ${checks.length} checks worked.`}
            {" "}"Arrived" means the movement came back through Windows. It cannot see inside the game itself.
          </div>
          <div style={{ maxHeight: 220, overflow: "auto", fontSize: 13 }} aria-label="Recent activity">
            {shown.map((e, i) => {
              const d = describeActivity(e);
              return (
                <div key={i} style={{ display: "flex", gap: 12, padding: "4px 0", borderBottom: "1px solid var(--bd)" }}>
                  <span className="num sub" style={{ width: 64 }}>{fmt(e.t)}</span>
                  <span className="sub" style={{ width: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.app || "–"}</span>
                  <span style={{ width: 100 }}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span style={{ flex: 1 }}>{d.text}</span>
                  <span style={{ width: 70, textAlign: "right", color: d.worked === null ? "var(--mu)" : d.worked ? "var(--ok)" : "var(--wn)" }}>
                    {d.worked === null ? "" : d.worked ? "✓ worked" : "✗ failed"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Version, update status and the buttons that go with each state. */
function UpdatesCard({ version, status, autoUpdate, onAuto }: { version: string; status: UpdateStatus; autoUpdate: boolean; onAuto(v: boolean): void }) {
  const u = window.kinetic?.updates;
  const message: Record<UpdateStatus["state"], string> = {
    dev: "Updates work in the installed app, not while developing.",
    unconfigured: "This build has no update source yet. See the README, \"Releasing updates\".",
    idle: "Not checked yet.",
    checking: "Checking for a new version…",
    none: "You're on the latest version.",
    available: "",
    downloading: "",
    ready: "",
    error: "",
  };
  let text = message[status.state];
  if (status.state === "available") text = `Version ${status.version} is available.`;
  if (status.state === "downloading") text = `Downloading… ${status.percent}%`;
  if (status.state === "ready") text = `Version ${status.version} is downloaded and ready.`;
  if (status.state === "error") text = `Could not check: ${status.message}`;
  const canCheck = ["dev", "unconfigured", "idle", "none", "error"].includes(status.state);
  const [asked, setAsked] = useState(false);
  const busy = status.state === "checking" || status.state === "downloading";

  return (
    <div className="card" style={{ padding: "6px 22px", flex: "none" }}>
      <div className="row plain">
        <span>Kinetic {version && <span className="num sub">v{version}</span>}<span className="sub" style={{ display: "block", fontSize: 12 }} role="status">{text}{asked && (status.state === "dev" || status.state === "unconfigured") ? " (Nothing to check yet.)" : ""}</span></span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {status.state === "downloading" && (
            <span className="trk" style={{ width: 120, cursor: "default" }} role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
              <span className="fil" style={{ width: `${status.percent}%` }} />
            </span>
          )}
          {(canCheck || busy) && <button type="button" className="btn2" disabled={!u || busy} onClick={() => { setAsked(true); u?.check(); }}>{status.state === "checking" ? "Checking…" : "Check for updates"}</button>}
          {status.state === "available" && <button type="button" className="btn" style={{ height: 36 }} onClick={() => u?.download()}>Download</button>}
          {status.state === "ready" && <button type="button" className="btn" style={{ height: 36 }} onClick={() => u?.install()}>Restart and update</button>}
        </span>
      </div>
      <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
        <span>Check for updates automatically<span className="sub" style={{ display: "block", fontSize: 12 }}>On startup and every few hours. Nothing installs until you say so.</span></span>
        <Toggle label="Check for updates automatically" on={autoUpdate} onChange={onAuto} />
      </div>
    </div>
  );
}

function Column({ tag, tagStyle, title, items, border, note }: { tag: string; tagStyle: React.CSSProperties; title: string; items: string[][]; border?: string; note?: string }) {
  return (
    <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 6, borderColor: border }}>
      <span className="tag" style={{ ...tagStyle, alignSelf: "flex-start", textTransform: "uppercase", letterSpacing: ".04em" }}>{tag}</span>
      <h2 style={{ fontSize: 16, fontWeight: 650, margin: "8px 0 6px" }}>{title}</h2>
      {items.map(([t, s]) => (
        <div key={t} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--bd)", fontSize: 14, lineHeight: 1.35 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 6, flex: "none", background: tagStyle.color as string }} />
          <div>{t}{s && <span className="sub" style={{ display: "block", fontSize: 12, marginTop: 2 }}>{s}</span>}</div>
        </div>
      ))}
      {note && <div style={{ flex: 1, display: "flex", alignItems: "flex-end" }}><div className="stat sub" style={{ fontSize: 13 }}>{note}</div></div>}
    </div>
  );
}

export function SettingsScreen({ engine, onRunSetup, onCalibrate, onRequestSupport }: { engine: EngineState; onRunSetup(): void; onCalibrate(): void; onRequestSupport(): void }) {
  const { theme, toggle } = useContext(ThemeContext);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState("");
  const [upd, setUpd] = useState<UpdateStatus>({ state: "idle" });
  useEffect(() => {
    window.kinetic?.getAppSettings?.().then(setApp).catch(() => setApp(null));
    window.kinetic?.getVersion?.().then(setVersion).catch(() => {});
    const u = window.kinetic?.updates;
    u?.getStatus().then(setUpd).catch(() => {});
    return u?.onStatus(setUpd);
  }, []);
  const change = (patch: Partial<AppSettings>) => window.kinetic?.setAppSettings?.(patch).then(setApp);

  return (
    <>
      <Top title="Settings" sub="Application settings, and what the app can really do on your mouse." />
      <div className="scroll-y" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="card" style={{ padding: "6px 22px", flex: "none" }}>
        <div className="row plain"><span>Dark theme</span><Toggle label="Dark theme" on={theme === "dark"} onChange={toggle} /></div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Start with Windows<span className="sub" style={{ display: "block", fontSize: 12 }}>Opens Kinetic in the tray at sign-in so remaps work straight away</span></span>
          <Toggle label="Start with Windows" on={!!app?.startWithWindows} disabled={!app} onChange={(v) => change({ startWithWindows: v })} />
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Keep running in the tray when the window is closed<span className="sub" style={{ display: "block", fontSize: 12 }}>The engine keeps your remaps working</span></span>
          <Toggle label="Keep running in the tray" on={!!app?.minimizeToTray} disabled={!app} onChange={(v) => change({ minimizeToTray: v })} />
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Pause for games with anti-cheat<span className="sub" style={{ display: "block", fontSize: 12 }}>Valorant and similar block input from other programs and can freeze the pointer. Turning this off runs Kinetic in them anyway, at your own risk of a freeze or a flag from the anti-cheat.</span></span>
          <Toggle label="Pause for games with anti-cheat" on={app?.gameGuard !== false} disabled={!app} onChange={(v) => change({ gameGuard: v })} />
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Engine</span>
          <span className="sub">{engine.connected ? `Running · version ${engine.version ?? "?"}` : "Not running"}</span>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>First-launch setup<span className="sub" style={{ display: "block", fontSize: 12 }}>Press each button on your mouse once so the app knows how many it has</span></span>
          <button type="button" className="btn2" onClick={onRunSetup}>Run again</button>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>DPI stages<span className="sub" style={{ display: "block", fontSize: 12 }}>Learn your mouse's DPI button and the DPI of each stage so the app follows it</span></span>
          <button type="button" className="btn2" onClick={onCalibrate}>Calibrate</button>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Mouse not fully supported?<span className="sub" style={{ display: "block", fontSize: 12 }}>Send the details to GitHub so support can be added in an update</span></span>
          <button type="button" className="btn2" onClick={onRequestSupport}>Request support</button>
        </div>
      </div>

      <ActivityCard engine={engine} on={!!app?.activityLog} disabled={!app} onToggle={(v) => { void change({ activityLog: v }); window.setTimeout(() => engine.requestActivity(), 300); }} />

      <UpdatesCard version={version} status={upd} autoUpdate={!!app?.autoUpdate} onAuto={(v) => change({ autoUpdate: v })} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 18, flex: "none", alignItems: "stretch" }}>
        <Column tag="Any mouse · software" tagStyle={{ background: "var(--oks)", color: "var(--ok)" }} title="Built into the core engine" items={ANY} border="var(--ok)" />
        <Column tag="Supported devices · driver" tagStyle={{ background: "var(--wns)", color: "var(--wn)" }} title="Needs each brand's protocol" items={DEVICE} border="var(--wn)" />
        <Column
          tag="Not possible"
          tagStyle={{ background: "var(--sub)", color: "var(--mu)" }}
          title="Limits of software"
          items={NOT}
          note="Every control is marked with its type, so nothing looks usable when it is not."
        />
      </div>
      </div>
    </>
  );
}
