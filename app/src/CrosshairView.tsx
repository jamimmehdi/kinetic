import { codeDocument, type Crosshair } from "./crosshair";
import "./crosshair.css";

/** Draws one crosshair centered in a square box. Used by the overlay window and the builder preview. */
export function CrosshairView({ c, size }: { c: Crosshair; size: number }) {
  const anim = c.anim === "none" ? undefined : `xh-${c.anim} ${(c.anim === "spin" ? 3 : c.anim === "pulse" ? 1.2 : 2) / c.speed}s ${c.anim === "spin" ? "linear" : "ease-in-out"} infinite`;
  const box = { width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center" } as const;

  if (c.kind === "code") {
    // A frame that runs no scripts: styles and animation work. It keeps the page's origin only so the
    // transparent overlay window can draw it; with scripts off, the code inside cannot reach anything.
    return (
      <div style={box}>
        <iframe
          title="Crosshair preview"
          sandbox="allow-same-origin"
          srcDoc={codeDocument(c)}
          style={{ width: size, height: size, border: 0, background: "transparent", colorScheme: "light" }}
        />
      </div>
    );
  }

  const half = c.thickness / 2;
  const o = c.outline;
  const g = c.gap;
  const e = c.gap + c.length;
  // Arms as rectangles: [x, y, width, height] around the center.
  const arms: [number, number, number, number][] = [];
  if (c.style === "cross" || c.style === "t") {
    if (c.style === "cross") arms.push([-half, -e, c.thickness, c.length]);
    arms.push([-half, g, c.thickness, c.length], [-e, -half, c.length, c.thickness], [g, -half, c.length, c.thickness]);
  }
  const ringR = c.gap + c.length / 2;
  const dot = c.style === "dot" ? Math.max(c.dot, 2) : c.dot;
  const extent = Math.max(e, ringR + half, dot / 2) + o + c.glow + 4;
  const span = Math.max(extent * 2, 16);
  const coreW = Math.max(1, Math.round(c.thickness / 2));

  return (
    <div style={box}>
      <svg
        viewBox={`${-span / 2} ${-span / 2} ${span} ${span}`}
        width={span}
        height={span}
        aria-hidden="true"
        style={{
          overflow: "visible",
          opacity: c.opacity / 100,
          filter: c.glow > 0 ? `drop-shadow(0 0 ${c.glow}px ${c.color}) drop-shadow(0 0 ${c.glow / 2}px ${c.color})` : undefined,
          animation: anim,
        }}
      >
        {o > 0 && (
          <g style={{ fill: c.outlineColor, stroke: c.outlineColor }}>
            {arms.map(([x, y, w, h], i) => <rect key={i} x={x - o} y={y - o} width={w + 2 * o} height={h + 2 * o} strokeWidth="0" />)}
            {c.style === "circle" && <circle r={ringR} fill="none" strokeWidth={c.thickness + 2 * o} />}
            {dot > 0 && <circle r={dot / 2 + o} strokeWidth="0" />}
          </g>
        )}
        <g style={{ fill: c.color, stroke: c.color }}>
          {arms.map(([x, y, w, h], i) => <rect key={i} x={x} y={y} width={w} height={h} strokeWidth="0" />)}
          {c.style === "circle" && <circle r={ringR} fill="none" strokeWidth={c.thickness} />}
          {dot > 0 && <circle r={dot / 2} strokeWidth="0" />}
        </g>
        {c.core && (
          <g style={{ fill: c.coreColor, stroke: c.coreColor }}>
            {arms.map(([x, y, w, h], i) => {
              const vertical = h > w;
              return vertical
                ? <rect key={i} x={-coreW / 2} y={y} width={coreW} height={h} strokeWidth="0" />
                : <rect key={i} x={x} y={-coreW / 2} width={w} height={coreW} strokeWidth="0" />;
            })}
            {c.style === "circle" && <circle r={ringR} fill="none" strokeWidth={coreW} />}
            {dot > 1 && <circle r={Math.max(dot / 2 - 0.5, 0.5)} strokeWidth="0" />}
          </g>
        )}
      </svg>
    </div>
  );
}
