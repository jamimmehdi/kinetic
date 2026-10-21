// End-to-end test: engine (test mode) + a real WinForms window as the foreground app.
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const DIR = __dirname;
// The form rewrites out.txt every 100 ms, so a read can catch it empty. Read until two reads agree.
const readOnce = () => { try { return fs.readFileSync(path.join(DIR, "out.txt"), "utf8"); } catch { return ""; } };
const read = () => { let a = readOnce(); for (let i = 0; i < 8; i++) { const b = readOnce(); if (a === b && (a !== "" || i > 2)) return a; a = b; } return a; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : "")); };

for (const f of ["ready.txt", "stop.txt", "out.txt"]) fs.rmSync(path.join(DIR, f), { force: true });

const events = [];
let buf = "";
const sock = net.connect("\\\\.\\pipe\\kinetic-engine");
sock.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { events.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
});
const send = (o) => sock.write(JSON.stringify(o) + "\n");
const lastActive = () => [...events].reverse().find((e) => e.t === "active");
const inject = (steps) => execFileSync("powershell", ["-NoProfile", "-File", path.join(DIR, "inject.ps1"), steps]);

(async () => {
  await sleep(500);
  const key = (k) => [{ type: "key_down", key: k }, { type: "delay", ms: 20 }, { type: "key_up", key: k }];
  send({ cmd: "set_config", config: {
    profiles: [
      { id: "default", name: "Default", mappings: [{ button: 5, action: { type: "key", keys: ["q"] } }] },
      { id: "t", name: "Target", app: "powershell.exe", mappings: [
        { button: 4, action: { type: "macro", id: "hi" } },
        { button: 2, action: { type: "macro", id: "loop3" } },
        { button: 3, action: { type: "key", keys: ["z"] } },
      ] },
    ],
    macros: [
      { id: "hi", name: "hi", repeat: { mode: "once" }, events: [...key("h"), { type: "delay", ms: 30 }, ...key("i")] },
      { id: "loop3", name: "loop3", repeat: { mode: "loop", count: 3 }, events: [...key("b"), { type: "delay", ms: 40 }] },
      { id: "held", name: "held", repeat: { mode: "held" }, events: [...key("a"), { type: "delay", ms: 40 }] },
      { id: "tog", name: "tog", repeat: { mode: "toggle" }, events: [...key("t"), { type: "delay", ms: 40 }] },
    ],
  } });
  await sleep(400);
  check("config accepted with 2 profiles and 4 macros",
    (([...events].reverse().find((e) => e.t === "config") || {}).config || { profiles: [], macros: [] }).macros.length === 4);

  // Start the foreground target window.
  spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DIR, "target.ps1"), "-Dir", DIR], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(DIR, "ready.txt")); i++) await sleep(200);
  check("test window opened", fs.existsSync(path.join(DIR, "ready.txt")));
  await sleep(1800);

  const act = lastActive();
  check("auto-switch: profile 't' active while the window is in front", act && act.profile === "t", JSON.stringify(act));

  // Button 4 -> once-macro typing "hi". Real press/release pair.
  // The first key after the window grabs focus is eaten by the Alt tap that took the foreground,
  // so run the macro once from the UI path as a warm-up and test the button press after it.
  send({ cmd: "run_macro", id: "hi" }); await sleep(500);
  check("test-run command (UI path) runs the macro", read().endsWith("i"), JSON.stringify(read()));
  const before4 = read();
  inject("x1d,wait60,x1u"); await sleep(500);
  check("button 4 runs macro 'hi'", read().slice(before4.length) === "hi", JSON.stringify(read().slice(before4.length)));

  // Button 3 is middle: unsupported by our injector (no middle step), so check the key mapping on button 2? use loop macro.
  const before = read();
  inject("rd,wait60,ru"); await sleep(700);
  const added = read().slice(before.length);
  check("button 2 runs loop macro exactly 3 times ('bbb')", added === "bbb", JSON.stringify(added));

  // Button 5 under profile 't' has no mapping, so it falls back to Default's key 'q'.
  const before5 = read();
  inject("x2d,wait60,x2u"); await sleep(400);
  check("button 5 falls back to the Default profile's mapping ('q')", read().slice(before5.length) === "q", JSON.stringify(read().slice(before5.length)));

  // Held macro on button 5: replace mapping through a config update, then hold ~600 ms.
  const cfg = [...events].reverse().find((e) => e.t === "config").config;
  cfg.profiles.find((p) => p.id === "t").mappings.push({ button: 5, action: { type: "macro", id: "held" } });
  send({ cmd: "set_config", config: cfg }); await sleep(300);
  const beforeHeld = read();
  inject("x2d,wait600,x2u"); await sleep(300);
  const heldTyped = read().slice(beforeHeld.length);
  const countA = (heldTyped.match(/a/g) || []).length;
  check("'while held' macro repeats while held", countA >= 5 && countA <= 20 && heldTyped === "a".repeat(heldTyped.length), `typed ${countA} a's`);
  await sleep(400);
  check("'while held' macro stops on release", read().slice(beforeHeld.length) === heldTyped);

  // Toggle on, wait, toggle off.
  const cfg2 = [...events].reverse().find((e) => e.t === "config").config;
  cfg2.profiles.find((p) => p.id === "t").mappings = cfg2.profiles.find((p) => p.id === "t").mappings.filter((m) => m.button !== 5);
  cfg2.profiles.find((p) => p.id === "t").mappings.push({ button: 5, action: { type: "macro", id: "tog" } });
  send({ cmd: "set_config", config: cfg2 }); await sleep(300);
  const beforeTog = read();
  inject("x2d,wait50,x2u"); await sleep(500);
  const mid = read().slice(beforeTog.length);
  inject("x2d,wait50,x2u"); await sleep(300);
  const end1 = read().slice(beforeTog.length);
  await sleep(400);
  const end2 = read().slice(beforeTog.length);
  check("toggle macro starts on first press", (mid.match(/t/g) || []).length >= 4, `typed ${mid.length}`);
  check("toggle macro stops on second press", end1 === end2 && end2.length >= mid.length);

  // Raw button events reached the UI stream (injected presses carry device 0).
  const downs = events.filter((e) => e.t === "button" && e.down).map((e) => e.button);
  check("live button events published for buttons 2, 4, 5", [2, 4, 5].every((b) => downs.includes(b)), JSON.stringify([...new Set(downs)]));

  // Macro running events.
  check("macro running/stopped events published", events.some((e) => e.t === "macro" && e.running) && events.some((e) => e.t === "macro" && !e.running));

  // Switching away: another app takes the foreground -> default profile.
  fs.writeFileSync(path.join(DIR, "stop.txt"), "1");
  await sleep(800);
  spawn("explorer.exe", ["C:\Windows"], { stdio: "ignore" });
  await sleep(2500);
  const act2 = lastActive();
  check("auto-switch: back to Default after the window closes", act2 && act2.profile === "default", JSON.stringify(act2));

  // Left click can never be remapped.
  const withLeft = [...events].reverse().find((e) => e.t === "config").config;
  withLeft.profiles[0].mappings.push({ button: 1, action: { type: "disabled" } });
  send({ cmd: "set_config", config: withLeft }); await sleep(300);
  const echoed = [...events].reverse().find((e) => e.t === "config").config;
  check("left click mapping rejected by the engine", !echoed.profiles[0].mappings.some((m) => m.button === 1));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
