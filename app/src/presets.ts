import type { DeviceInfo } from "./engine";

export interface Preset {
  id: string;
  label: string;
  keys: string[];
}

export const MEDIA_PRESETS: Preset[] = [
  { id: "playpause", label: "Play / Pause", keys: ["playpause"] },
  { id: "next", label: "Next track", keys: ["nexttrack"] },
  { id: "prev", label: "Previous track", keys: ["prevtrack"] },
  { id: "volup", label: "Volume up", keys: ["volumeup"] },
  { id: "voldown", label: "Volume down", keys: ["volumedown"] },
  { id: "mute", label: "Mute", keys: ["volumemute"] },
];

export const WINDOWS_PRESETS: Preset[] = [
  { id: "copy", label: "Copy", keys: ["ctrl", "c"] },
  { id: "paste", label: "Paste", keys: ["ctrl", "v"] },
  { id: "cut", label: "Cut", keys: ["ctrl", "x"] },
  { id: "undo", label: "Undo", keys: ["ctrl", "z"] },
  { id: "selectall", label: "Select all", keys: ["ctrl", "a"] },
  { id: "taskview", label: "Task view", keys: ["win", "tab"] },
  { id: "desktop", label: "Show desktop", keys: ["win", "d"] },
  { id: "snip", label: "Screenshot", keys: ["win", "shift", "s"] },
  { id: "switch", label: "Switch app", keys: ["alt", "tab"] },
  { id: "close", label: "Close window", keys: ["alt", "f4"] },
  { id: "back", label: "Browser back", keys: ["browserback"] },
  { id: "forward", label: "Browser forward", keys: ["browserforward"] },
  { id: "lock", label: "Lock PC", keys: ["win", "l"] },
];

export const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

const VENDORS: Record<number, string> = {
  0x1532: "Razer",
  0x046d: "Logitech",
  0x1038: "SteelSeries",
  0x1b1c: "Corsair",
  0x258a: "Glorious",
  0x1bcf: "Generic",
  0x093a: "Generic",
};

/** "Razer mouse" when the vendor is known, otherwise the engine's own name. */
export function deviceLabel(d: DeviceInfo | undefined): string {
  if (!d) return "No mouse found";
  const v = VENDORS[d.vid];
  return v ? `${v} mouse` : d.name;
}
