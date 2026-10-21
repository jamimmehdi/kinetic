// Screenshots of the Steady hand screen and the hold-still test, from the dev server (mock engine).
// Usage: SHOOT_OUT=<dir> SHOOT_BASE=http://127.0.0.1:5173/ electron scripts/shoot-steady.js
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
    const win = new BrowserWindow({ width: 1500, height: 900, show: false, useContentSize: true, webPreferences: { sandbox: true } });
    await win.loadURL(base);
    const run = (code) => win.webContents.executeJavaScript(code);
    await run(`localStorage.setItem("kinetic.mock.setupDone", "1"); localStorage.setItem("kinetic.theme", "dark");`);
    await win.webContents.reload();
    await sleep(1200);
    const shot = async (name) => {
      await sleep(400);
      fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
      log("shot " + name);
    };
    const click = (text) => run(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
    await run(`document.querySelector('[aria-label="Steady hand"]').click()`);
    await sleep(1200);
    await click("Medium");
    await sleep(900);
    // The first capture of a fresh hidden window can be one frame behind, so take one and drop it.
    await win.webContents.capturePage();
    await sleep(400);
    await shot("steady-hand");
    await click("Test my hand");
    await sleep(500);
    await shot("steady-test-1-start");
    await click("Start the test");
    await sleep(2800);
    await shot("steady-test-2-running");
    await sleep(10500);
    await shot("steady-test-3-result");
  } catch (e) {
    log(String(e && e.stack || e));
  }
  app.quit();
});
