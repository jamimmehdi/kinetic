import { useEffect, useRef, useState } from "react";
import {
  activeCrosshair, DEFAULT_STATE, HOTKEYS, newCrosshair, SAMPLE_CSS, SAMPLE_HTML, SWATCHES,
  type Crosshair, type CrosshairState, type XhAnim, type XhStyle,
} from "../crosshair";
import { CrosshairView } from "../CrosshairView";
import { Seg, Slider, Tag, Toggle, Top } from "../ui";

type Tab = "shape" | "color" | "motion" | "code" | "overlay";
const TABS: { id: Tab; label: string }[] = [
  { id: "shape", label: "Shape" },
  { id: "color", label: "Color and glow" },
  { id: "motion", label: "Animation" },
  { id: "code", label: "HTML and CSS" },
  { id: "overlay", label: "Overlay" },
];
const STYLES: { id: XhStyle; label: string }[] = [
  { id: "cross", label: "Cross" },
  { id: "t", label: "T shape" },
  { id: "circle", label: "Ring" },
  { id: "dot", label: "Dot only" },
];
const ANIMS: { id: XhAnim; label: string }[] = [
  { id: "none", label: "None" },
  { id: "pulse", label: "Pulse" },
  { id: "breathe", label: "Breathe" },
  { id: "spin", label: "Spin" },
];
const BRIGHTNESS = [
  { id: "100", label: "100%" },
  { id: "60", label: "60%" },
  { id: "30", label: "30%" },
];

const ZOOMS = [
  { id: "1", label: "1x" },
  { id: "2", label: "2x" },
  { id: "4", label: "4x" },
];

/** Crosshair state kept in the main process (so the overlay window and the hotkey see it too). */
function useCrosshairState() {
  const [state, setState] = useState<CrosshairState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(state);
  useEffect(() => {
    const bridge = window.kinetic?.crosshair;
    if (!bridge) { setLoaded(true); return; }
    let alive = true;
    bridge.get().then((s) => { if (alive) { latest.current = s; setState(s); setLoaded(true); } }).catch(() => setLoaded(true));
    // The only change made outside this screen is the hotkey turning the overlay on or off.
    const off = bridge.onState((s) => {
      const next = { ...latest.current, overlay: s.overlay };
      latest.current = next;
      setState(next);
    });
    return () => { alive = false; off(); };
  }, []);
  const commit = (next: CrosshairState) => {
    latest.current = next;
    setState(next);
    void window.kinetic?.crosshair?.set(next);
  };
  return { state, loaded, commit };
}

const uid = () => `xh-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** A crosshair that is drawn over your game. The builder edits the active one live. */
export function CrosshairScreen() {
  const { state, commit } = useCrosshairState();
  const [tab, setTab] = useState<Tab>("shape");
  const [brightness, setBrightness] = useState("30");
  const [zoom, setZoom] = useState("2");
  const [displays, setDisplays] = useState<string[]>([]);
  const [hotkeyOk, setHotkeyOk] = useState(true);
  const c = activeCrosshair(state);

  useEffect(() => {
    window.kinetic?.crosshair?.displays().then(setDisplays).catch(() => {});
  }, []);
  useEffect(() => {
    window.kinetic?.crosshair?.hotkeyOk().then(setHotkeyOk).catch(() => {});
  }, [state.hotkey]);

  const edit = (change: Partial<Crosshair>) =>
    commit({ ...state, list: state.list.map((x) => (x.id === c.id ? { ...x, ...change } : x)) });
  const patch = (change: Partial<CrosshairState>) => commit({ ...state, ...change });
  const duplicate = () => {
    const copy: Crosshair = { ...c, id: uid(), name: `${c.name} copy`.slice(0, 40) };
    commit({ ...state, list: [...state.list, copy], activeId: copy.id });
  };
  const remove = () => {
    if (state.list.length < 2) return;
    const list = state.list.filter((x) => x.id !== c.id);
    commit({ ...state, list, activeId: list[0].id });
  };
  const add = () => {
    const fresh = newCrosshair(uid(), "New crosshair");
    commit({ ...state, list: [...state.list, fresh], activeId: fresh.id });
  };

  const row = (label: string, value: string, control: React.ReactNode) => (
    <div className="row plain" style={{ minHeight: 40, gap: 14 }}>
      <span style={{ width: 110, flex: "none" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 40 }}>{control}</div>
      <span className="num sub" style={{ width: 54, textAlign: "right", flex: "none" }}>{value}</span>
    </div>
  );
  const colorRow = (label: string, value: string, onChange: (v: string) => void, ariaLabel: string) => (
    <div className="row plain" style={{ minHeight: 40, gap: 14 }}>
      <span style={{ width: 110, flex: "none" }}>{label}</span>
      <input type="color" className="xh-color" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <span className="num sub">{value}</span>
    </div>
  );

  return (
    <>
      <Top title="Crosshair" sub="Draws on top of your game while the overlay is on. It only draws; it never reads or touches the game.">
        <span className="pill"><span className="num" style={{ fontSize: 12, color: "var(--mu)" }}>{state.hotkey}</span>Toggle overlay</span>
        <span className="pill" style={{ gap: 12 }}>
          Overlay
          <Toggle label="Show the crosshair over games" on={state.overlay} onChange={(v) => patch({ overlay: v })} />
        </span>
      </Top>

      <div className="grid12" style={{ gridTemplateRows: "minmax(0,1fr) auto" }}>
        <div className="card" style={{ gridColumn: "span 7", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="lbl">Live preview on a game scene</span>
            <Tag kind="all">Any mouse</Tag>
          </div>
          <div className="xh-stage xh-preview">
            <div className="xh-scene" style={{ filter: `brightness(${Number(brightness) / 100})` }}>
              <i style={{ left: 0, top: 0, width: "100%", height: "46%", background: "#3D5A3F" }} />
              <i style={{ left: 0, top: "46%", width: "100%", height: "54%", background: "#4A4F45" }} />
              <i style={{ left: "12%", top: "18%", width: "22%", height: "46%", background: "#5D7A5A" }} />
              <i style={{ left: "62%", top: "26%", width: "26%", height: "38%", background: "#6A8A5F" }} />
              <i style={{ left: "44%", top: "60%", width: "12%", height: "14%", background: "#364A37" }} />
            </div>
            <div className="xh-center"><div style={{ transform: `scale(${zoom})` }}><CrosshairView c={c} size={256} /></div></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="sub">Screen brightness</span>
            <Seg label="Preview screen brightness" value={brightness} options={BRIGHTNESS} onChange={setBrightness} />
            <div style={{ flex: 1 }} />
            <span className="sub">Zoom</span>
            <Seg label="Preview zoom" value={zoom} options={ZOOMS} onChange={setZoom} />
          </div>
          <div className="sub" style={{ fontSize: 12 }}>
            Try 30% to see how it reads on a dim monitor. The overlay shows in Borderless or Windowed mode, not exclusive Fullscreen. It cannot be brighter than the monitor itself, so use the outline and the second color to stand out.
          </div>
        </div>

        <div className="card" style={{ gridColumn: "span 5", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14, overflow: "auto" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="input" style={{ flex: 1 }} aria-label="Crosshair name" value={c.name} maxLength={40} onChange={(e) => edit({ name: e.target.value })} />
            <button type="button" className="btn2" onClick={duplicate}>Duplicate</button>
            <button type="button" className="btn2" onClick={remove} disabled={state.list.length < 2}>Delete</button>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} role="tablist" aria-label="Crosshair settings">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`xh-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {c.kind === "code" && tab !== "code" && tab !== "overlay" && (
            <div className="sub">This crosshair is drawn from your own HTML and CSS. Open the HTML and CSS tab to edit it, or switch back to the builder there.</div>
          )}

          {tab === "shape" && c.kind === "builder" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="lbl">Style</div>
              <Seg label="Crosshair style" value={c.style} options={STYLES} onChange={(v) => edit({ style: v })} />
              {row("Length", `${c.length} px`, <Slider label="Length" width="100%" min={1} max={40} step={1} value={c.length} disabled={c.style === "dot"} onChange={(v) => edit({ length: v })} />)}
              {row("Thickness", `${c.thickness} px`, <Slider label="Thickness" width="100%" min={1} max={10} step={1} value={c.thickness} disabled={c.style === "dot"} onChange={(v) => edit({ thickness: v })} />)}
              {row("Center gap", `${c.gap} px`, <Slider label="Center gap" width="100%" min={0} max={30} step={1} value={c.gap} disabled={c.style === "dot"} onChange={(v) => edit({ gap: v })} />)}
              {row("Center dot", `${c.dot} px`, <Slider label="Center dot" width="100%" min={0} max={12} step={1} value={c.dot} onChange={(v) => edit({ dot: v })} />)}
              {row("Opacity", `${c.opacity}%`, <Slider label="Opacity" width="100%" min={20} max={100} step={5} value={c.opacity} onChange={(v) => edit({ opacity: v })} />)}
            </div>
          )}

          {tab === "color" && c.kind === "builder" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="lbl">Color</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minHeight: 36 }}>
                {SWATCHES.map((hex) => (
                  <button key={hex} type="button" className={`xh-sw ${c.color === hex ? "on" : ""}`} style={{ background: hex }} aria-label={`Color ${hex}`} aria-pressed={c.color === hex} onClick={() => edit({ color: hex })} />
                ))}
              </div>
              {colorRow("Custom color", c.color, (v) => edit({ color: v }), "Custom crosshair color")}
              <div className="lbl" style={{ marginTop: 8 }}>Make it stand out</div>
              {row("Glow", c.glow === 0 ? "off" : `${c.glow} px`, <Slider label="Glow" width="100%" min={0} max={20} step={1} value={c.glow} onChange={(v) => edit({ glow: v })} />)}
              {row("Dark outline", c.outline === 0 ? "off" : `${c.outline} px`, <Slider label="Outline thickness" width="100%" min={0} max={4} step={1} value={c.outline} onChange={(v) => edit({ outline: v })} />)}
              {colorRow("Outline color", c.outlineColor, (v) => edit({ outlineColor: v }), "Outline color")}
              <div className="row plain" style={{ minHeight: 40, gap: 14 }}>
                <span style={{ flex: 1 }}>Second color down the middle</span>
                <Toggle label="Second color down the middle" on={c.core} onChange={(v) => edit({ core: v })} />
              </div>
              {c.core && colorRow("Middle color", c.coreColor, (v) => edit({ coreColor: v }), "Middle color")}
            </div>
          )}

          {tab === "motion" && c.kind === "builder" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="lbl">Motion</div>
              <Seg label="Animation" value={c.anim} options={ANIMS} onChange={(v) => edit({ anim: v })} />
              {row("Speed", `${c.speed.toFixed(1)}x`, <Slider label="Animation speed" width="100%" min={0.5} max={3} step={0.1} value={c.speed} disabled={c.anim === "none"} onChange={(v) => edit({ speed: v })} />)}
              <div className="sub" style={{ fontSize: 12 }}>For your own keyframes, use the HTML and CSS tab.</div>
            </div>
          )}

          {tab === "code" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="row plain" style={{ minHeight: 36, gap: 14 }}>
                <span style={{ flex: 1 }}>Draw this crosshair from my HTML and CSS</span>
                <Toggle label="Use my own HTML and CSS" on={c.kind === "code"} onChange={(v) => edit({ kind: v ? "code" : "builder" })} />
              </div>
              <label className="lbl" htmlFor="xh-html">HTML</label>
              <textarea id="xh-html" className="xh-code" spellCheck={false} rows={3} value={c.html} onChange={(e) => edit({ html: e.target.value })} />
              <label className="lbl" htmlFor="xh-css">CSS</label>
              <textarea id="xh-css" className="xh-code" spellCheck={false} rows={9} value={c.css} onChange={(e) => edit({ css: e.target.value })} />
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button type="button" className="btn2" onClick={() => edit({ html: SAMPLE_HTML, css: SAMPLE_CSS })}>Load the example</button>
                <span className="sub" style={{ fontSize: 12 }}>Keep the crosshair around the center (0, 0). Styles and animation work. Scripts and web images are blocked.</span>
              </div>
            </div>
          )}

          {tab === "overlay" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="lbl">Where it shows</div>
              <div className="row plain" style={{ minHeight: 40, gap: 14 }}>
                <span style={{ width: 110, flex: "none" }}>Monitor</span>
                <select className="input select" aria-label="Monitor" value={state.display} onChange={(e) => patch({ display: Number(e.target.value) })}>
                  {(displays.length > 0 ? displays : ["Monitor 1"]).map((name, i) => <option key={i} value={i}>{name}</option>)}
                </select>
              </div>
              {row("Move left or right", `${state.offsetX} px`, <Slider label="Horizontal offset" width="100%" min={-200} max={200} step={1} value={state.offsetX} onChange={(v) => patch({ offsetX: v })} />)}
              {row("Move up or down", `${state.offsetY} px`, <Slider label="Vertical offset" width="100%" min={-200} max={200} step={1} value={state.offsetY} onChange={(v) => patch({ offsetY: v })} />)}
              <div className="row plain" style={{ minHeight: 40, gap: 14 }}>
                <span style={{ width: 110, flex: "none" }}>Hotkey</span>
                <select className="input select" aria-label="Hotkey" value={state.hotkey} onChange={(e) => patch({ hotkey: e.target.value })}>
                  {HOTKEYS.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              {!hotkeyOk && <div className="sub" style={{ color: "var(--wn)" }}>Another program is using {state.hotkey}. Pick a different hotkey.</div>}
              <div className="sub" style={{ fontSize: 12 }}>Offsets are measured from the middle of the monitor. The hotkey turns the overlay on and off while you play.</div>
            </div>
          )}
        </div>

        <div className="card" style={{ gridColumn: "span 12", padding: "16px 22px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ minWidth: 96 }}>
            <div className="lbl">Saved</div>
            <div className="sub" style={{ fontSize: 12, marginTop: 4 }}>On this PC</div>
          </div>
          <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 0, overflowX: "auto", padding: "2px 0" }}>
            {state.list.map((x) => (
              <button key={x.id} type="button" className={`xh-chip ${x.id === c.id ? "on" : ""}`} aria-pressed={x.id === c.id} onClick={() => patch({ activeId: x.id })}>
                <span className="xh-thumb">
                  {x.kind === "code" ? <span className="num" style={{ color: "#fff", fontSize: 12 }}>{"</>"}</span> : <span style={{ transform: "scale(0.7)" }}><CrosshairView c={x} size={60} /></span>}
                </span>
                {x.name}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={add}>New crosshair</button>
        </div>
      </div>
    </>
  );
}
