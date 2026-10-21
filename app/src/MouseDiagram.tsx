import type { MouseModel } from "./models/types";

interface Props {
  model: MouseModel;
  selected: number;
  /** Buttons held down right now. They light up on the drawing. */
  pressed: ReadonlySet<number>;
  onSelect(id: number): void;
}

/** Line drawing with numbered callouts, driven entirely by the model data. */
export function MouseDiagram({ model, selected, pressed, onSelect }: Props) {
  const [w, h] = model.viewBox;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ maxWidth: 460, maxHeight: "100%", display: "block" }}
      role="group"
      aria-label={`${model.name}, ${model.buttons.length} buttons`}
    >
      <path d={model.outline} fillRule="evenodd" style={{ fill: "var(--line)" }} />

      {model.buttons.map((b) => {
        const live = pressed.has(b.id);
        const active = live || b.id === selected;
        const [bx, by] = b.badge;
        const [tx, ty] = b.target;
        return (
          <g key={b.id}>
            {b.shape && (
              <path
                d={b.shape}
                style={{ fill: active ? "var(--ac)" : "none", stroke: active ? "var(--act)" : "none" }}
                fillOpacity={0.9}
                strokeWidth={4}
              />
            )}
            <line
              x1={bx} y1={by} x2={tx} y2={ty}
              style={{ stroke: active ? "var(--ac)" : "var(--line)" }}
              strokeWidth={active ? 5 : 3}
              strokeOpacity={active ? 1 : 0.7}
            />
            <circle cx={tx} cy={ty} r={live ? 16 : 9} style={{ fill: active ? "var(--ac)" : "var(--line)" }} />
            <g
              role="button"
              tabIndex={0}
              aria-label={`Button ${b.id}: ${b.label}`}
              aria-pressed={b.id === selected}
              style={{ cursor: "pointer", outline: "none" }}
              onClick={() => onSelect(b.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(b.id);
                }
              }}
            >
              <circle
                className="badge-circle"
                cx={bx} cy={by} r={active ? 38 : 34}
                style={{ fill: active ? "var(--ac)" : "var(--card)", stroke: active ? "var(--act)" : "var(--line)" }}
                strokeWidth={3}
              />
              <text
                x={bx} y={by + 11} textAnchor="middle" fontSize={30} fontWeight={700}
                style={{ fill: active ? "#fff" : "var(--tx)", pointerEvents: "none" }}
              >
                {b.id}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
