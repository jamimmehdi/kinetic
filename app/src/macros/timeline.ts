import type { MacroEvent } from "../engine";

export interface Block {
  lane: "keyboard" | "mouse" | "delay";
  start: number;
  end: number;
  label: string;
}

export interface Timeline {
  blocks: Block[];
  /** Total length in milliseconds, at least 1. */
  total: number;
}

/** Lays macro events out on a time axis: key and button holds, moves and waits. */
export function buildTimeline(events: MacroEvent[]): Timeline {
  const blocks: Block[] = [];
  const keysDown = new Map<string, number>();
  const mouseDown = new Map<string, number>();
  let t = 0;

  for (const e of events) {
    switch (e.type) {
      case "key_down":
        if (!keysDown.has(e.key)) keysDown.set(e.key, t);
        break;
      case "key_up": {
        const s = keysDown.get(e.key);
        if (s !== undefined) {
          blocks.push({ lane: "keyboard", start: s, end: t, label: e.key.toUpperCase() });
          keysDown.delete(e.key);
        }
        break;
      }
      case "mouse_down":
        if (!mouseDown.has(e.button)) mouseDown.set(e.button, t);
        break;
      case "mouse_up": {
        const s = mouseDown.get(e.button);
        if (s !== undefined) {
          blocks.push({ lane: "mouse", start: s, end: t, label: `${e.button} click` });
          mouseDown.delete(e.button);
        }
        break;
      }
      case "move":
        blocks.push({ lane: "mouse", start: t, end: t, label: "move" });
        break;
      case "delay":
        if (e.ms > 0) blocks.push({ lane: "delay", start: t, end: t + e.ms, label: `${e.ms} ms` });
        t += Math.max(0, e.ms);
        break;
    }
  }

  const total = Math.max(t, 1);
  // Anything still held at the end is shown as held to the end.
  for (const [key, s] of keysDown) blocks.push({ lane: "keyboard", start: s, end: total, label: key.toUpperCase() });
  for (const [button, s] of mouseDown) blocks.push({ lane: "mouse", start: s, end: total, label: `${button} hold` });
  return { blocks, total };
}
