import { useEffect, useRef, useState } from "react";
import {
  isMouseName,
  newId,
  type EngineState,
  type MacroDef,
  type MacroEvent,
  type Repeat,
} from "../engine";
import { engineKey } from "../macros/keys";
import { Top } from "../ui";
import { buildTimeline } from "../macros/timeline";

type AddKind = "key_tap" | "key_down" | "key_up" | "click" | "mouse_down" | "mouse_up" | "delay" | "move";

const ADD_KINDS: { id: AddKind; label: string; hint: string }[] = [
  { id: "key_tap", label: "Key tap", hint: "key, for example r" },
  { id: "key_down", label: "Key down", hint: "key" },
  { id: "key_up", label: "Key up", hint: "key" },
  { id: "click", label: "Mouse click", hint: "left, right, middle, back or forward" },
  { id: "mouse_down", label: "Mouse down", hint: "left, right, middle, back or forward" },
  { id: "mouse_up", label: "Mouse up", hint: "left, right, middle, back or forward" },
  { id: "delay", label: "Delay", hint: "milliseconds, for example 100" },
  { id: "move", label: "Move pointer", hint: "dx,dy in pixels, for example 0,14" },
];

const REPEATS: { id: Repeat["mode"]; label: string }[] = [
  { id: "once", label: "Once" },
  { id: "held", label: "While held" },
  { id: "toggle", label: "Toggle" },
  { id: "loop", label: "Loop × N" },
];

const TAP_MS = 40;

function describeEvent(e: MacroEvent): string {
  switch (e.type) {
    case "key_down": return `Key down · ${e.key}`;
    case "key_up": return `Key up · ${e.key}`;
    case "mouse_down": return `Mouse down · ${e.button}`;
    case "mouse_up": return `Mouse up · ${e.button}`;
    case "delay": return `Delay · ${e.ms} ms`;
    case "move": return `Move · ${e.dx}, ${e.dy}`;
  }
}

/** Turns the add-bar input into events, or null when the value is not usable. */
function eventsFor(kind: AddKind, value: string): MacroEvent[] | null {
  const v = value.trim().toLowerCase();
  const num = (s: string) => Number.parseInt(s, 10);
  switch (kind) {
    case "key_tap":
      return v ? [{ type: "key_down", key: v }, { type: "delay", ms: TAP_MS }, { type: "key_up", key: v }] : null;
    case "key_down":
      return v ? [{ type: "key_down", key: v }] : null;
    case "key_up":
      return v ? [{ type: "key_up", key: v }] : null;
    case "click":
      return isMouseName(v) ? [{ type: "mouse_down", button: v }, { type: "delay", ms: TAP_MS }, { type: "mouse_up", button: v }] : null;
    case "mouse_down":
      return isMouseName(v) ? [{ type: "mouse_down", button: v }] : null;
    case "mouse_up":
      return isMouseName(v) ? [{ type: "mouse_up", button: v }] : null;
    case "delay": {
      const ms = num(v);
      return Number.isFinite(ms) && ms >= 0 ? [{ type: "delay", ms: Math.min(ms, 60000) }] : null;
    }
    case "move": {
      const [dx, dy] = v.split(",").map((s) => num(s));
      return Number.isFinite(dx) && Number.isFinite(dy) ? [{ type: "move", dx, dy }] : null;
    }
  }
}

export function MacrosScreen({ engine }: { engine: EngineState }) {
  const { config } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(config.macros[0]?.id ?? null);
  const macro = config.macros.find((m) => m.id === selectedId) ?? config.macros[0] ?? null;

  const [name, setName] = useState(macro?.name ?? "");
  useEffect(() => setName(macro?.name ?? ""), [macro?.id, macro?.name]);

  const [addKind, setAddKind] = useState<AddKind>("key_tap");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState("");

  const [recording, setRecording] = useState(false);
  const recorded = useRef<MacroEvent[]>([]);
  const lastAt = useRef(0);

  function save(next: MacroDef) {
    engine.setConfig({ ...config, macros: config.macros.map((m) => (m.id === next.id ? next : m)) });
  }

  function addMacro() {
    const id = newId("m");
    engine.setConfig({
      ...config,
      macros: [...config.macros, { id, name: "New macro", repeat: { mode: "once" }, events: [] }],
    });
    setSelectedId(id);
  }

  function deleteMacro() {
    if (!macro) return;
    // Mappings that pointed at this macro are dropped by the engine when it sanitizes the config.
    engine.setConfig({ ...config, macros: config.macros.filter((m) => m.id !== macro.id) });
    setSelectedId(null);
  }

  // Recording listens to this window only, never globally, so it cannot see typing elsewhere.
  useEffect(() => {
    if (!recording) return;
    recorded.current = [];
    lastAt.current = performance.now();
    const push = (e: KeyboardEvent, down: boolean) => {
      if (e.repeat) return;
      const key = engineKey(e);
      if (!key) return;
      e.preventDefault();
      const now = performance.now();
      const gap = Math.round(now - lastAt.current);
      if (recorded.current.length > 0 && gap >= 5) recorded.current.push({ type: "delay", ms: Math.min(gap, 60000) });
      recorded.current.push(down ? { type: "key_down", key } : { type: "key_up", key });
      lastAt.current = now;
    };
    const down = (e: KeyboardEvent) => push(e, true);
    const up = (e: KeyboardEvent) => push(e, false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [recording]);

  function toggleRecording() {
    if (recording && macro) {
      setRecording(false);
      if (recorded.current.length) save({ ...macro, events: [...macro.events, ...recorded.current] });
      recorded.current = [];
    } else if (macro) {
      setRecording(true);
    }
  }

  if (!macro) {
    return (
      <>
        <Top title="Macro builder" sub="Record or build sequences with millisecond timing, then give them to any button.">
          <button className="btn" type="button" onClick={addMacro}>New macro</button>
        </Top>
        <div className="empty card">
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--tx)" }}>No macros yet</div>
          <div className="sub">Create one, record some keys or add steps, then assign it to a button on the Buttons screen.</div>
        </div>
      </>
    );
  }

  const running = engine.runningMacros.has(macro.id);
  const timeline = buildTimeline(macro.events);
  const pct = (ms: number) => `${(ms / timeline.total) * 100}%`;

  function setEvent(i: number, e: MacroEvent) {
    save({ ...macro!, events: macro!.events.map((x, j) => (j === i ? e : x)) });
  }
  function removeEvent(i: number) {
    save({ ...macro!, events: macro!.events.filter((_, j) => j !== i) });
  }
  function moveEvent(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= macro!.events.length) return;
    const events = macro!.events.slice();
    [events[i], events[j]] = [events[j], events[i]];
    save({ ...macro!, events });
  }

  function add() {
    const made = eventsFor(addKind, addValue);
    if (!made) {
      setAddError(`Needs a value: ${ADD_KINDS.find((k) => k.id === addKind)?.hint}`);
      return;
    }
    setAddError("");
    setAddValue("");
    save({ ...macro!, events: [...macro!.events, ...made] });
  }

  return (
    <>
      <Top title="Macro builder" sub="Record or build sequences with millisecond timing, then give them to any button.">
        <button className="btn" type="button" onClick={toggleRecording}>
          <span className={`rec ${recording ? "on" : ""}`} />
          {recording ? "Stop recording" : "Record keys"}
        </button>
      </Top>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "240px minmax(0,1fr)", gap: 18 }}>
        <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 4, overflow: "auto" }}>
          <div className="lbl" style={{ padding: "4px 12px 8px" }}>Your macros</div>
          {config.macros.map((m) => (
            <button key={m.id} type="button" className={`row tall ${m.id === macro.id ? "on" : ""}`} onClick={() => setSelectedId(m.id)}>
              <span>{m.name || "Untitled"}</span>
              <span className="sub num">{m.events.length} ev</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="btn2" type="button" style={{ justifyContent: "center" }} onClick={addMacro}>New macro</button>
        </div>

        <div className="card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0, overflow: "auto" }}>
          {recording && (
            <div className="banner" role="status">
              Recording keys pressed in this window. Press Stop when you are done. Mouse clicks and moves can be added as steps.
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <input
              className="input title-input"
              aria-label="Macro name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() !== macro.name && save({ ...macro, name: name.trim() || "Untitled" })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="sub">Length</span>
              <span className="num" style={{ fontSize: 18, color: "var(--act)" }}>{timeline.total === 1 && macro.events.length === 0 ? 0 : timeline.total} ms</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Timeline">
            {(["keyboard", "mouse", "delay"] as const).map((lane) => (
              <div key={lane} style={{ display: "flex", gap: 14 }}>
                <div className="ln">{lane === "keyboard" ? "Keyboard" : lane === "mouse" ? "Mouse" : "Delays"}</div>
                <div className="lane" style={{ flex: 1 }}>
                  {timeline.blocks.filter((b) => b.lane === lane).map((b, i) => (
                    <div
                      key={i}
                      className={`blk ${lane}`}
                      title={`${b.label} at ${b.start} ms`}
                      style={{ left: pct(b.start), width: `max(${pct(b.end - b.start)}, 28px)` }}
                    >
                      {b.label}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="lbl">Steps</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {macro.events.length === 0 && <div className="sub">No steps yet. Record keys or add steps below.</div>}
            {macro.events.map((e, i) => (
              <div className="step" key={i}>
                <span className="num sub">{i + 1}</span>
                <span style={{ flex: 1 }}>{describeEvent(e)}</span>
                {e.type === "delay" && (
                  <input
                    className="input narrow num"
                    type="number"
                    min={0}
                    max={60000}
                    aria-label={`Delay for step ${i + 1} in milliseconds`}
                    value={e.ms}
                    onChange={(ev) => setEvent(i, { type: "delay", ms: Math.max(0, Math.min(60000, Number(ev.target.value) || 0)) })}
                  />
                )}
                <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} up`} onClick={() => moveEvent(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} down`} onClick={() => moveEvent(i, 1)} disabled={i === macro.events.length - 1}>↓</button>
                <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => removeEvent(i)}>✕</button>
              </div>
            ))}
          </div>

          <form
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <select className="input select" aria-label="Step type" value={addKind} onChange={(e) => { setAddKind(e.target.value as AddKind); setAddError(""); }}>
              {ADD_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <input
              className="input"
              aria-label="Step value"
              placeholder={ADD_KINDS.find((k) => k.id === addKind)?.hint}
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              style={{ minWidth: 180 }}
            />
            <button className="btn2" type="submit">Add step</button>
          </form>
          {addError && <div className="sub" role="alert" style={{ color: "var(--wn)" }}>{addError}</div>}

          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid var(--bd)" }}>
            <span className="lbl" style={{ marginRight: 4 }}>Repeat</span>
            {REPEATS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`chip ${macro.repeat.mode === r.id ? "on" : ""}`}
                onClick={() => save({ ...macro, repeat: r.id === "loop" ? { mode: "loop", count: 3 } : ({ mode: r.id } as Repeat) })}
              >
                {r.label}
              </button>
            ))}
            {macro.repeat.mode === "loop" && (
              <input
                className="input narrow num"
                type="number"
                min={1}
                max={10000}
                aria-label="Number of loops"
                value={macro.repeat.count}
                onChange={(e) => save({ ...macro, repeat: { mode: "loop", count: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) } })}
              />
            )}
            <span style={{ flex: 1 }} />
            <button className="btn2" type="button" onClick={deleteMacro}>Delete</button>
            {running ? (
              <button className="btn" type="button" onClick={() => engine.stopMacros()}>Stop</button>
            ) : (
              <button className="btn2" type="button" onClick={() => engine.runMacro(macro.id)} disabled={!engine.connected || macro.events.length === 0}>
                Test run
              </button>
            )}
          </div>
          <div className="sub">
            Assign this macro to a button on the Buttons screen. Key names: letters, digits, f1 to f24, ctrl, shift, alt, win, enter, esc, tab, space, arrows.
          </div>
        </div>
      </div>
    </>
  );
}
