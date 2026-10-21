// End-to-end test of software movement, DPI actions, the Shift layer, pause, scrolling and pointer
// settings. Needs the engine running in test mode (see README). Moves the real cursor a few pixels
// and puts it back, and uses the WinForms target window for the typing checks.
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : "")); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const readOnce = () => { try { return fs.readFileSync(path.join(DIR, "out.txt"), "utf8"); } catch { return ""; } };
const read = () => { let a = readOnce(); for (let i = 0; i < 8; i++) { const b = readOnce(); if (a === b && (a !== "" || i > 2)) return a; a = b; } return a; };
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
const last = (t) => [...events].reverse().find((e) => e.t === t);
const inject = (steps) => execFileSync("powershell", ["-NoProfile", "-File", path.join(DIR, "inject.ps1"), steps]).toString().trim();
const pos = () => inject("pos").split(",").map(Number);

const perf = (over = {}) => ({
  native_dpi: 1600,
  stages: [{ dpi: 400 }, { dpi: 800 }, { dpi: 1600 }, { dpi: 3200 }],
  active_stage: 2, independent_xy: false, rotation: 0, y_ratio: 1, angle_snap: false, smoothing: 0, raw_movement: true,
  accel: { mode: "off", kind: "sensitivity", rate: 0.8, offset: 0, limit: 2.5, midpoint: 4, exponent: 2, speed_cap: false, per_axis: false, points: [[0, 1], [4, 1.5], [8, 2.5]] },
  scroll: { lines: 3, smooth: false, reverse: false },
  ...over,
});
const setConfig = async (p, mappings = [], shift = []) => {
  send({ cmd: "set_config", config: { profiles: [{ id: "default", name: "Default", mappings, shift_mappings: shift, perf: p }], macros: [] } });
  await sleep(400);
};
// Moves n steps of (dx, dy) and returns how far the cursor really went, after a priming move
// (the first move after switching processing on passes through natively by design).
const travel = async (dx, dy, n) => {
  inject("setpos900_500,wait30,mv1_0,mv-1_0,wait60");
  const a = pos();
  inject(Array.from({ length: n }, () => `mv${dx}_${dy}`).join(","));
  await sleep(150);
  const b = pos();
  return [b[0] - a[0], b[1] - a[1]];
};

(async () => {
  await sleep(500);
  const home = pos();
  const spiBefore = inject("spi");

  await setConfig(perf());
  let [x, y] = await travel(10, 0, 5);
  check("native sensitivity: no software processing, movement unchanged", near(x, 50, 2) && near(y, 0, 1), `moved ${x},${y}`);
  check("native sensitivity: engine reports processing off", last("dpi").processing === false);

  await setConfig(perf({ active_stage: 3 }));
  [x, y] = await travel(10, 0, 5);
  check("3200 DPI on a 1600 DPI mouse doubles movement", near(x, 100, 3) && near(y, 0, 1), `moved ${x},${y}`);
  check("engine reports processing on with 3200 DPI", last("dpi").processing === true && last("dpi").dpi_x === 3200);

  await setConfig(perf({ active_stage: 1 }));
  [x, y] = await travel(4, 0, 10);
  check("800 DPI halves movement", near(x, 20, 3), `moved ${x},${y}`);

  await setConfig(perf({ independent_xy: true, stages: [{ dpi: 400 }, { dpi: 800 }, { dpi: 1600, dpi_y: 800 }, { dpi: 3200 }], active_stage: 2 }));
  [x, y] = await travel(10, 10, 5);
  check("independent X/Y: Y at 800 DPI moves half as far", near(x, 50, 2) && near(y, 25, 3), `moved ${x},${y}`);

  await setConfig(perf({ y_ratio: 0.5 }));
  [x, y] = await travel(10, 10, 5);
  check("vertical ratio 0.5 halves only vertical movement", near(x, 50, 2) && near(y, 25, 3), `moved ${x},${y}`);

  await setConfig(perf({ rotation: 90 }));
  [x, y] = await travel(10, 0, 5);
  check("rotation 90 degrees turns horizontal movement into vertical", near(x, 0, 3) && near(y, 50, 3), `moved ${x},${y}`);

  await setConfig(perf({ angle_snap: true }));
  [x, y] = await travel(10, 1, 8);
  check("angle snapping removes the wobble from a straight stroke", near(x, 80, 2) && Math.abs(y) <= 1, `moved ${x},${y}`);

  // Pointer settings while processing is on, then restored.
  await setConfig(perf({ active_stage: 3, scroll: { lines: 7, smooth: false, reverse: false } }));
  const during = inject("spi").split(",");
  check("Windows pointer acceleration is off while processing", during[0] === "0" && during[1] === "10", during.join(","));
  check("scroll lines per notch follow the profile", during[2] === "7", during.join(","));

  // DPI actions on buttons: 5 cycles, 4 holds the sniper stage.
  await setConfig(perf(), [{ button: 5, action: { type: "dpi", op: "cycle" } }, { button: 4, action: { type: "dpi", op: "hold", stage: 1 } }]);
  inject("x2d,wait50,x2u"); await sleep(300);
  [x, y] = await travel(10, 0, 5);
  check("after cycling to 3200 DPI the pointer really moves twice as far", near(x, 100, 3), `moved ${x},${y}`);
  check("DPI cycle button moves to the next stage (3200)", last("dpi").stage === 3 && last("dpi").dpi_x === 3200, JSON.stringify(last("dpi")));
  inject("x1d"); await sleep(300);
  [x, y] = await travel(10, 0, 4);
  check("while the hold button is down the pointer moves at the 800 stage (half)", near(x, 20, 3), `moved ${x},${y}`);
  check("DPI hold button switches to its stage while held", last("dpi").stage === 1, JSON.stringify(last("dpi")));
  inject("x1u"); await sleep(300);
  check("releasing the hold button returns to the previous stage", last("dpi").stage === 3, JSON.stringify(last("dpi")));

  // Telemetry.
  inject("mv5_0,mv5_0,mv5_0,mv5_0,mv5_0,mv5_0"); await sleep(400);
  const tel = [...events].reverse().find((e) => e.t === "telemetry" && e.moving);
  check("live telemetry published while moving", !!tel && tel.speed > 0, JSON.stringify(tel));

  // Scrolling: reverse, and smooth scrolling that adds up to one notch.
  await setConfig(perf({ scroll: { lines: 3, smooth: false, reverse: true } }));
  let mark = events.length;
  inject("wheel-120"); await sleep(300);
  const wheels = events.slice(mark).filter((e) => e.t === "wheel").map((e) => e.delta);
  check("reverse scrolling sends the opposite wheel direction", wheels.includes(120), JSON.stringify(wheels));
  await setConfig(perf({ scroll: { lines: 3, smooth: true, reverse: false } }));
  mark = events.length;
  inject("wheel120"); await sleep(600);
  const parts = events.slice(mark).filter((e) => e.t === "wheel" && e.delta > 0 && e.delta < 120).map((e) => e.delta);
  check("smooth scrolling splits a notch into steps that add up to 120", parts.length >= 6 && parts.reduce((a, b) => a + b, 0) === 120, JSON.stringify(parts));

  // Pause bypasses everything.
  await setConfig(perf({ active_stage: 3 }), [{ button: 5, action: { type: "dpi", op: "cycle" } }]);
  send({ cmd: "set_paused", paused: true }); await sleep(300);
  check("engine reports paused", (last("engine") || {}).paused === true);
  [x, y] = await travel(10, 0, 5);
  check("paused: movement is native even with 3200 DPI configured", near(x, 50, 2), `moved ${x},${y}`);
  const stageBefore = last("dpi").stage;
  inject("x2d,wait50,x2u"); await sleep(250);
  check("paused: remapped buttons do nothing", last("dpi").stage === stageBefore);
  const spiPaused = inject("spi");
  check("paused: pointer settings are back to the user's own", spiPaused === spiBefore, `${spiPaused} vs ${spiBefore}`);
  send({ cmd: "set_paused", paused: false }); await sleep(300);
  [x, y] = await travel(10, 0, 5);
  check("resumed: processing is back", near(x, 100, 3), `moved ${x},${y}`);

  // Shift layer, typed into the real target window.
  spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DIR, "target.ps1"), "-Dir", DIR], { stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(DIR, "ready.txt")); i++) await sleep(200);
  await sleep(1800);
  await setConfig(perf(), [{ button: 4, action: { type: "shift" } }, { button: 5, action: { type: "key", keys: ["q"] } }], [{ button: 5, action: { type: "key", keys: ["w"] } }]);
  inject("x2d,wait40,x2u"); await sleep(120); // warm-up: the first key after focus is eaten by the test window
  const t0 = read();
  inject("x2d,wait40,x2u"); await sleep(250);
  check("Shift layer: base layer button types 'q'", read().slice(t0.length) === "q", JSON.stringify(read().slice(t0.length)));
  const t1 = read();
  inject("x1d,wait80,x2d,wait40,x2u,wait80,x1u"); await sleep(250);
  check("Shift layer: holding the Shift button types 'w' instead", read().slice(t1.length) === "w", JSON.stringify(read().slice(t1.length)));
  check("layer events published", events.some((e) => e.t === "layer" && e.shift) && events.some((e) => e.t === "layer" && !e.shift));
  const t2 = read();
  inject("x2d,wait40,x2u"); await sleep(250);
  check("Shift layer: back to 'q' after releasing the Shift button", read().slice(t2.length) === "q", JSON.stringify(read().slice(t2.length)));
  fs.writeFileSync(path.join(DIR, "stop.txt"), "1");

  // Put things back.
  send({ cmd: "set_config", config: { profiles: [{ id: "default", name: "Default", mappings: [] }], macros: [] } }); await sleep(400);
  inject(`setpos${home[0]}_${home[1]}`);
  const spiAfter = inject("spi");
  check("pointer settings restored after the test", spiAfter === spiBefore, `${spiAfter} vs ${spiBefore}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
