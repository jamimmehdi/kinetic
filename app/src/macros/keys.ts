const NAMED: Record<string, string> = {
  ControlLeft: "ctrl", ControlRight: "ctrl",
  ShiftLeft: "shift", ShiftRight: "shift",
  AltLeft: "alt", AltRight: "alt",
  MetaLeft: "win", MetaRight: "win",
  Enter: "enter", NumpadEnter: "enter", Escape: "esc", Tab: "tab", Space: "space",
  Backspace: "backspace", Delete: "delete", Insert: "insert",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

/** Key name the engine understands for a keyboard event, or null when the engine has no such key. */
export function engineKey(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c.toLowerCase();
  return NAMED[c] ?? null;
}
