// Screenshot of the Sessions screen from the dev server (mock engine with sample sessions).
// Usage: SHOOT_OUT=<dir> SHOOT_BASE=http://127.0.0.1:5173/ electron scripts/shoot-sessions.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.SHOOT_OUT;
const base = process.env.SHOOT_BASE || "http://127.0.0.1:5173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => fs.appendFileSync(path.join(out, "shoot.log"), m + "\n");

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    // Taller than usual, because the dashboard is a long page.
    const win = new BrowserWindow({ width: 1500, height: 1500, show: false, useContentSize: true, webPreferences: { sandbox: true } });
    await win.loadURL(base);
    const run = (code) => win.webContents.executeJavaScript(code);
    await run(`localStorage.setItem("kinetic.mock.setupDone", "1"); localStorage.setItem("kinetic.theme", "dark");`);
    await win.webContents.reload();
    await sleep(1200);
    await run(`document.querySelector('[aria-label="Sessions"]').click()`);
    await sleep(1200);
    await run(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Track Valorant").click()`);
    await sleep(1200);
    await win.webContents.capturePage();
    await sleep(500);
    fs.writeFileSync(path.join(out, "sessions.png"), (await win.webContents.capturePage()).toPNG());
    log("shot sessions");
    // The session that had trouble: Windows refused Kinetic's input for a while.
    await run(`[...document.querySelectorAll('[role="option"]')].pop().click()`);
    await sleep(1500);
    fs.writeFileSync(path.join(out, "sessions-trouble.png"), (await win.webContents.capturePage()).toPNG());
    log("shot sessions-trouble");
  } catch (e) {
    log(String(e && e.stack || e));
  }
  app.quit();
});
