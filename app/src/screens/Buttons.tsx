import { useEffect, useMemo, useRef, useState } from "react";
import { MouseDiagram } from "../MouseDiagram";
import { wirelessMouse } from "../models/wireless-mouse";
import { engineKey } from "../macros/keys";
import { deviceLabel, MEDIA_PRESETS, sameKeys, WINDOWS_PRESETS } from "../presets";
import { Pill, Seg, Top } from "../ui";
import {
  describeAction,
  getProfile,
  isMouseName,
  withProfile,
  type Action,
  type EngineState,
  type Mapping,
  type MouseButtonName,
} from "../engine";

type Category = "keyboard" | "mouse" | "macro" | "media" | "windows" | "launch" | "dpi" | "shift";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "keyboard", label: "Keyboard" },
  { id: "mouse", label: "Mouse" },
  { id: "macro", label: "Macro" },
  { id: "media", label: "Media" },
  { id: "windows", label: "Windows" },
  { id: "launch", label: "Launch app" },
  { id: "dpi", label: "DPI & profile" },
  { id: "shift", label: "Layer shift" },
];

function categoryOf(a: Action | undefined): Category {
  if (!a) return "keyboard";
  switch (a.type) {
    case "key":
      if (MEDIA_PRESETS.some((p) => sameKeys(p.keys, a.keys))) return "media";
      if (WINDOWS_PRESETS.some((p) => sameKeys(p.keys, a.keys))) return "windows";
      return "keyboard";
    case "mouse":
    case "disabled":
      return "mouse";
    case "macro": return "macro";
    case "launch": return "launch";
    case "dpi": return "dpi";
    case "shift": return "shift";
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MOUSE_BUTTONS: MouseButtonName[] = ["left", "right", "middle", "back", "forward"];

interface Props {
  engine: EngineState;
  profileId: string;
  onProfileChange(id: string): void;
}

export function ButtonsScreen({ engine, profileId, onProfileChange }: Props) {
  const model = wirelessMouse;
  const { config, pressed, lastPressed } = engine;
  const profile = getProfile(config, profileId);
  const device = engine.devices[0];

  const [layer, setLayer] = useState<"base" | "shift">("base");
  const [selected, setSelected] = useState(4);

  // Every button of the model, plus extras the device reports beyond the drawing.
  const extras = useMemo(
    () => (device?.extras ?? []).filter((e) => !model.buttons.some((b) => b.id === e.button)),
    [device, model],
  );
  const rows = useMemo(
    () => [
      ...model.buttons.map((b) => ({ id: b.id, label: b.label, fallback: b.defaultAction })),
      ...extras.map((e) => ({ id: e.button, label: e.label, fallback: "Not assigned" })),
    ],
    [model, extras],
  );
  const known = rows.some((r) => r.id === selected) ? selected : rows[0].id;
  const row = rows.find((r) => r.id === known)!;

  // Pressing a button on the real mouse selects it in the UI.
  useEffect(() => {
    if (lastPressed !== null && rows.some((r) => r.id === lastPressed)) setSelected(lastPressed);
  }, [lastPressed, rows]);

  const list = layer === "shift" ? profile.shift_mappings : profile.mappings;
  const mapping = list.find((m) => m.button === known);
  const isActive = engine.activeProfile === profile.id;
  const canRemap = known >= 2 && known <= 16;
  const stageNames = profile.perf.stages.map((s) => s.dpi);

  const [category, setCategory] = useState<Category>(categoryOf(mapping?.action));
  useEffect(() => setCategory(categoryOf(mapping?.action)), [known, layer, profile.id, mapping]);

  function commit(action: Action | null) {
    const key = layer === "shift" ? "shift_mappings" : "mappings";
    engine.setConfig(
      withProfile(config, profile.id, (p) => {
        const rest = p[key].filter((m: Mapping) => m.button !== known);
        return { ...p, [key]: action ? [...rest, { button: known, action }] : rest };
      }),
    );
  }

  // ---- keyboard recorder ----
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const key = engineKey(e);
      if (!key || ["ctrl", "shift", "alt", "win"].includes(key)) return; // wait for the real key
      const mods = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.metaKey && "win"].filter(Boolean) as string[];
      commit({ type: "key", keys: [...mods, key] });
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // commit changes identity each render but only reads current state when a key arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, known, layer, profile.id, config]);

  const keys = mapping?.action.type === "key" ? mapping.action.keys : [];

  // ---- launch ----
  const [launchPath, setLaunchPath] = useState("");
  useEffect(() => setLaunchPath(mapping?.action.type === "launch" ? mapping.action.path : ""), [mapping, known]);
  const dpiAct = mapping?.action.type === "dpi" ? mapping.action : null;

  // ---- learn a button ----
  const [learnName, setLearnName] = useState("");
  const learning = engine.learn.state !== "idle";

  const peek = (a: Action | undefined, fb: string) => describeAction(a, fb, config.macros, stageNames);

  return (
    <>
      <Top title="Button mapping" sub="Works on any mouse. Remaps apply system-wide, before apps see them.">
        <Pill tone={engine.connected ? "ok" : "warn"}>
          {engine.connected
            ? device
              ? `${deviceLabel(device)} · ${Math.max(device.buttons, rows.length)} buttons`
              : "Engine running · no mouse found"
            : "Engine not running"}
        </Pill>
        <label className="sub" htmlFor="profile-pick">Profile</label>
        <select id="profile-pick" className="input select" value={profile.id} onChange={(e) => onProfileChange(e.target.value)}>
          {config.profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.id === engine.activeProfile ? " (active)" : ""}</option>
          ))}
        </select>
        <Seg<"base" | "shift"> label="Layer" value={layer} onChange={setLayer} options={[{ id: "base", label: "Base layer" }, { id: "shift", label: "Shift layer" }]} />
      </Top>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0,1.05fr) minmax(0,1fr)", gap: 18 }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "18px 22px 20px", overflow: "auto" }}>
          <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 10 }}>
            <span className={`dot ${engine.connected ? "ok" : ""}`} />
            <span className="sub">{engine.connected ? "Live · press a button on your mouse and it lights up here" : "Start the engine to see live presses"}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
            <MouseDiagram model={model} selected={known} pressed={pressed} onSelect={setSelected} />
          </div>
          <div style={{ width: "100%", borderTop: "1px solid var(--bd)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="lbl">Extra buttons</span>
              <span className="sub">{extras.length} found on this mouse</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {extras.map((e) => (
                <button key={e.button} type="button" className={`chip ${pressed.has(e.button) ? "on" : ""}`} onClick={() => setSelected(e.button)}>
                  <b className="num" style={{ marginRight: 8, color: "var(--tx)" }}>{e.button}</b>{e.label}
                </button>
              ))}
              <button type="button" className="chip dashed" disabled={!engine.connected || learning} onClick={() => { setLearnName(""); engine.learnStart(); }}>
                + Press a button to detect
              </button>
            </div>
            {engine.learn.state === "listening" && (
              <div className="banner" role="status" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Press and release the new button three or four times now.</span>
                <button type="button" className="btn2" onClick={() => engine.learnCancel()}>Cancel</button>
              </div>
            )}
            {engine.learn.state === "found" && (
              <form
                style={{ display: "flex", gap: 8, alignItems: "center" }}
                onSubmit={(e) => { e.preventDefault(); engine.learnConfirm(learnName); }}
              >
                <span className="sub">Found button {engine.learn.button}. Name it:</span>
                <input className="input" aria-label="Button name" value={learnName} maxLength={40} placeholder="for example Thumb grid" onChange={(e) => setLearnName(e.target.value)} />
                <button className="btn" type="submit" style={{ height: 38 }}>Add</button>
                <button className="btn2" type="button" onClick={() => engine.learnCancel()}>Cancel</button>
              </form>
            )}
            {engine.learn.state === "none" && (
              <div className="banner" role="status" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  {engine.learn.saw_reports
                    ? "Saw signals but could not tell which was a button. Press only that one button, a few times."
                    : "Nothing came from the mouse. This button may be handled inside the mouse itself."}
                </span>
                <button type="button" className="btn2" onClick={() => engine.learnStart()}>Try again</button>
              </div>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: "var(--ac)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontWeight: 700 }}>{known}</span>
              <div>
                <div className="lbl">Selected button · {profile.name}{isActive ? " · active" : ""}{layer === "shift" ? " · Shift layer" : ""}</div>
                <div style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>{row.label}</div>
              </div>
            </div>
            <button className="btn2" type="button" disabled={!mapping} onClick={() => commit(null)}>Reset</button>
          </div>

          {canRemap ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Action type">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip ${category === c.id ? "on" : ""}`}
                    disabled={c.id === "shift" && layer === "shift"}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {category === "keyboard" && (
                <button
                  ref={recorderRef}
                  type="button"
                  onClick={() => setRecording(true)}
                  onBlur={() => setRecording(false)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderRadius: 12, background: "var(--sub)", border: "1px dashed var(--ac)", cursor: "pointer", textAlign: "left", width: "100%", minHeight: 62 }}
                >
                  {recording ? (
                    <span style={{ color: "var(--act)", fontWeight: 600 }}>Press the shortcut now… (Esc to cancel)</span>
                  ) : keys.length ? (
                    keys.map((k, i) => (
                      <span key={i} style={{ display: "contents" }}>
                        {i > 0 && <span className="sub">+</span>}
                        <span className="key">{cap(k)}</span>
                      </span>
                    ))
                  ) : (
                    <span className="sub">No shortcut yet</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span className="sub">Click to record a new shortcut</span>
                </button>
              )}

              {category === "mouse" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Mouse button">
                  {MOUSE_BUTTONS.map((n) => (
                    <button key={n} type="button" className={`chip ${mapping?.action.type === "mouse" && mapping.action.button === n ? "on" : ""}`} onClick={() => isMouseName(n) && commit({ type: "mouse", button: n })}>
                      {cap(n)} click
                    </button>
                  ))}
                  <button type="button" className={`chip ${mapping?.action.type === "disabled" ? "on" : ""}`} onClick={() => commit({ type: "disabled" })}>Do nothing</button>
                </div>
              )}

              {category === "macro" &&
                (config.macros.length === 0 ? (
                  <div className="sub">No macros yet. Build one on the Macros screen, then pick it here.</div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Macro">
                    {config.macros.map((m) => (
                      <button key={m.id} type="button" className={`chip ${mapping?.action.type === "macro" && mapping.action.id === m.id ? "on" : ""}`} onClick={() => commit({ type: "macro", id: m.id })}>
                        {m.name || "Untitled"}
                      </button>
                    ))}
                  </div>
                ))}

              {category === "media" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Media action">
                  {MEDIA_PRESETS.map((p) => (
                    <button key={p.id} type="button" className={`chip ${keys.length > 0 && sameKeys(keys, p.keys) ? "on" : ""}`} onClick={() => commit({ type: "key", keys: p.keys })}>
                      {p.label}
                    </button>
                  ))}
                </div>
              )}

              {category === "windows" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Windows action">
                  {WINDOWS_PRESETS.map((p) => (
                    <button key={p.id} type="button" className={`chip ${keys.length > 0 && sameKeys(keys, p.keys) ? "on" : ""}`} onClick={() => commit({ type: "key", keys: p.keys })}>
                      {p.label}
                    </button>
                  ))}
                </div>
              )}

              {category === "launch" && (
                <form
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                  onSubmit={(e) => { e.preventDefault(); if (launchPath.trim()) commit({ type: "launch", path: launchPath.trim() }); }}
                >
                  <label className="sub" htmlFor="launch-path">Program</label>
                  <input id="launch-path" className="input" value={launchPath} placeholder="C:\Program Files\App\app.exe" onChange={(e) => setLaunchPath(e.target.value)} />
                  {window.kinetic?.pickFile && (
                    <button type="button" className="btn2" onClick={async () => { const p = await window.kinetic!.pickFile!(); if (p) setLaunchPath(p); }}>Browse</button>
                  )}
                  <button className="btn" type="submit" style={{ height: 38 }}>Apply</button>
                </form>
              )}

              {category === "dpi" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="DPI action">
                    {([["cycle", "Cycle stage"], ["up", "DPI up"], ["down", "DPI down"], ["set", "Go to stage"], ["hold", "Hold a stage"]] as const).map(([op, label]) => (
                      <button key={op} type="button" className={`chip ${dpiAct?.op === op ? "on" : ""}`} onClick={() => commit({ type: "dpi", op, stage: dpiAct?.stage ?? 0 })}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {dpiAct && (dpiAct.op === "set" || dpiAct.op === "hold") && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <label className="sub" htmlFor="dpi-stage">{dpiAct.op === "hold" ? "While held, use" : "Go to"}</label>
                      <select id="dpi-stage" className="input select" value={dpiAct.stage} onChange={(e) => commit({ type: "dpi", op: dpiAct.op, stage: Number(e.target.value) })}>
                        {profile.perf.stages.map((s, i) => <option key={i} value={i}>Stage {i + 1} · {s.dpi} DPI</option>)}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {category === "shift" && (
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <button type="button" className={`chip ${mapping?.action.type === "shift" ? "on" : ""}`} onClick={() => commit({ type: "shift" })}>
                    Use this button as the Shift button
                  </button>
                  <span className="sub">While you hold it, the Shift layer's mappings apply.</span>
                </div>
              )}
            </>
          ) : (
            <div className="sub">
              {known === 1
                ? "Left click can't be remapped, so a bad mapping can never lock you out."
                : "This button can't be remapped."}
            </div>
          )}

          {known > 5 && canRemap && (
            <div className="sub">This button reports through the mouse's own signal. Its original function still happens; the action here is added.</div>
          )}

          <div className="lbl" style={{ marginTop: 2 }}>All buttons</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {rows.map((r) => {
              const m = list.find((x) => x.button === r.id);
              const live = pressed.has(r.id);
              return (
                <button key={r.id} type="button" className={`row ${live ? "live" : r.id === known ? "on" : ""}`} onClick={() => setSelected(r.id)}>
                  <span><b className="nb">{r.id}</b>{r.label}</span>
                  <span className="sub" style={m ? { color: live ? undefined : "var(--act)", fontWeight: 600 } : undefined}>
                    {peek(m?.action, r.fallback)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
