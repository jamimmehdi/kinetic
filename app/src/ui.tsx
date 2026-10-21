import { createContext, useContext, useRef, type ReactNode, type KeyboardEvent, type PointerEvent } from "react";

// ---- theme --------------------------------------------------------------------------------------

export type Theme = "dark" | "light";
export const ThemeContext = createContext<{ theme: Theme; toggle(): void }>({ theme: "dark", toggle: () => {} });

export function ThemeButton() {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <button
      type="button"
      className="tbtn"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title="Theme"
    >
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        )}
      </svg>
    </button>
  );
}

/** Screen header: title and subtitle on the left, the theme button and extras on the right. */
export function Top({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="top">
      <div>
        <h1 className="h1">{title}</h1>
        {sub && <div className="sub" style={{ marginTop: 4 }}>{sub}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ThemeButton />
        {children}
      </div>
    </div>
  );
}

// ---- controls ----------------------------------------------------------------------------------

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange(next: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`tog ${on ? "" : "off"}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(v: number): void;
  label: string;
  width?: number | string;
  disabled?: boolean;
}

const round = (v: number, step: number) => Math.round(v / step) * step;

/** Track and knob exactly as drawn on the design board, with pointer and keyboard support. */
export function Slider({ value, min, max, step, onChange, label, width = 150, disabled }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = ((Math.min(Math.max(value, min), max) - min) / (max - min)) * 100;

  const fromPointer = (e: PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    onChange(Number(Math.min(Math.max(round(min + t * (max - min), step), min), max).toFixed(6)));
  };
  const key = (e: KeyboardEvent) => {
    const big = (max - min) / 10;
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -big, PageUp: big }[e.key];
    if (e.key === "Home") onChange(min);
    else if (e.key === "End") onChange(max);
    else if (delta !== undefined) onChange(Number(Math.min(Math.max(value + delta, min), max).toFixed(6)));
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={`trk ${disabled ? "disabled" : ""}`}
      style={{ width }}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled}
      onKeyDown={disabled ? undefined : key}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && !disabled && fromPointer(e)}
    >
      <div className="fil" style={{ width: `${pct}%` }} />
      <div className="knb" style={{ left: `${pct}%` }} />
    </div>
  );
}

/** Circular DPI gauge with an editable number in the middle. */
export function Dial({ value, max, min = 50, step = 50, onChange, label, disabled }: { value: number; max: number; min?: number; step?: number; onChange(v: number): void; label: string; disabled?: boolean }) {
  const CIRC = 402; // 2 * pi * 64
  const frac = Math.min(Math.max(value / max, 0), 1);
  const clamp = (v: number) => Math.min(Math.max(Math.round(v), min), 32000);
  return (
    <div style={{ position: "relative", width: 180, height: 180 }}>
      <svg viewBox="0 0 160 160" width="180" height="180" role="img" aria-label={`${label}, ${value} DPI`}>
        <circle cx="80" cy="80" r="64" fill="none" style={{ stroke: "var(--bd)" }} strokeWidth="10" />
        <circle
          cx="80" cy="80" r="64" fill="none" style={{ stroke: "var(--ac)" }} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${frac * CIRC} ${CIRC}`} transform="rotate(-90 80 80)"
        />
        <text x="80" y="108" textAnchor="middle" fontSize="11" style={{ fill: "var(--mu)" }}>DPI</text>
      </svg>
      <input
        className="dial-input"
        type="number"
        min={min}
        max={32000}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={`${label} DPI`}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && e.target.value !== "") onChange(clamp(n));
        }}
      />
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange(v: T): void; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tag({ kind, children }: { kind: "all" | "dev"; children: ReactNode }) {
  return <span className={`tag ${kind === "all" ? "t-all" : "t-dev"}`}>{children}</span>;
}

export function Pill({ tone, children }: { tone?: "ok" | "warn" | "none"; children: ReactNode }) {
  return (
    <span className="pill">
      <span className={`dot ${tone === "ok" ? "ok" : tone === "warn" ? "warn" : ""}`} />
      {children}
    </span>
  );
}

/** Stable colour per profile for avatars. */
const AVATAR_COLORS = ["#d14b5a", "#2f6fdb", "#7a55d6", "#1f8a5f", "#b7791f", "#0e8f9c", "#c2578f"];
export function avatarColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
