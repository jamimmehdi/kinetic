// Screenshots of the Settings cards for kernel mode and the activity log, from the dev server (mock engine).
// Usage: SHOOT_OUT=<dir> SHOOT_BASE=http://[::1]:5173/ electron scripts/shoot-kernel.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.SHOOT_OUT;
const base = process.env.SHOOT_BASE || "http://[::1]:5173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => fs.appendFileSync(path.join(out, "shoot.log"), m + "\n");

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    const win = new BrowserWindow({ width: 1500, height: 900, show: false, useContentSize: true, webPreferences: { sandbox: true } });
    await win.loadURL(base);
    const run = (code) => win.webContents.executeJavaScript(code);
    await run(`localStorage.setItem("kinetic.mock.setupDone", "1"); localStorage.setItem("kinetic.theme", "dark");`);
    await win.webContents.reload();
    await sleep(1000);
    // Performance with the smoothing readout in milliseconds.
    await run(`document.querySelector('[aria-label="Performance"]').click()`);
    await sleep(500);
    fs.writeFileSync(path.join(out, "performance.png"), (await win.webContents.capturePage()).toPNG());
    log("shot performance");
    await run(`document.querySelector('[aria-label="Settings"]').click()`);
    await sleep(500);
    // The top of Settings, before anything is scrolled or switched on.
    fs.writeFileSync(path.join(out, "settings.png"), (await win.webContents.capturePage()).toPNG());
    log("shot settings");
    // The activity log needs to be on to show its list.
    await run(`document.querySelector('[aria-label="Record activity"]').click()`);
    await sleep(700);
    const shot = async (name, text) => {
      await run(`(() => { const el = [...document.querySelectorAll(".card")].find((c) => c.textContent.includes(${JSON.stringify(text)})); el.scrollIntoView({ block: "start" }); })()`);
      await sleep(500);
      fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
      log("shot " + name);
    };
    await shot("settings-kernel-mode", "Kernel mode (Raw Accel)");
    await shot("settings-activity-log", "Activity log");
  } catch (e) {
    log(String(e && e.stack || e));
  }
  app.quit();
});
