// Takes full-resolution screenshots of every screen from the running dev server (mock engine).
// Usage: set SHOOT_URL, SHOOT_OUT, SHOOT_THEME (dark|light), SHOOT_W, SHOOT_H, SHOOT_SEED=1 (adds sample data),
// then run: electron scripts/shoot.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const url = process.env.SHOOT_URL, outDir = process.env.SHOOT_OUT, theme = process.env.SHOOT_THEME || "dark", w = process.env.SHOOT_W || "1280", h = process.env.SHOOT_H || "800";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => fs.appendFileSync(path.join(outDir || ".", "shoot.log"), m + "\n");

// Helpers run inside the page: React inputs need the native setter plus an input event.
const PAGE = `
  window.__click = (sel, text) => { const els = [...document.querySelectorAll(sel)]; const el = text ? els.find((e) => e.textContent.trim() === text) : els[0]; if (!el) throw new Error("no " + sel + " " + (text || "")); el.click(); };
  window.__set = (sel, v) => { const el = document.querySelector(sel); const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
  window.__nav = (n) => document.querySelector('[aria-label="' + n + '"]').click();
  0;
`;

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const win = new BrowserWindow({ width: +w, height: +h, show: false, useContentSize: true, webPreferences: { sandbox: true } });
    await win.loadURL(url);
    const run = async (code) => {
      try { return await win.webContents.executeJavaScript(code); } catch (e) { log("FAILED: " + code.trim().slice(0, 90)); throw e; }
    };
    await run(`localStorage.setItem("kinetic.theme", "${theme}"); document.documentElement.dataset.theme = "${theme}";` + PAGE);
    await sleep(600);

    if (process.env.SHOOT_SEED) {
      // A macro, a linked profile, a custom curve and a mapped button, so the screens show real content.
      await run(`__nav("Macros"); `); await sleep(200);
      await run(`__click("button", "New macro")`); await sleep(200);
      for (const [type, value] of [["key_tap", "r"], ["delay", "100"], ["click", "left"], ["key_tap", "q"]]) {
        await run(`__set('[aria-label="Step type"]', "${type}")`); await sleep(60);
        await run(`__set('[aria-label="Step value"]', "${value}")`); await sleep(60);
        await run(`__click("button", "Add step")`); await sleep(120);
      }
      await run(`__nav("Profiles"); `); await sleep(200);
      await run(`__click("button", "New profile")`); await sleep(250);
      await run(`__set('[aria-label=\"Profile name\"]', "Valorant FPS")`); await run(`document.querySelector('[aria-label=\"Profile name\"]').dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`); await sleep(200);
      await run(`__set("#papp", "valorant.exe")`); await run(`document.querySelector("#papp").dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`); await sleep(200);
      await run(`__nav("Acceleration"); `); await sleep(250);
      await run(`__click("button", "Sigmoid")`); await sleep(250);
    }

    const screens = ["Dashboard", "Buttons", "Performance", "Acceleration", "Macros", "Profiles", "Settings"];
    for (const name of screens) {
      await run(`__nav("${name}")`);
      await sleep(500);
      if (process.env.SHOOT_SEED && name === "Dashboard") await run(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }))`);
      if (name === "Dashboard" && process.env.SHOOT_SEED) await sleep(2500);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name.toLowerCase()}-${theme}.png`), image.toPNG());
    }
  } catch (e) {
    log(String(e && e.stack || e));
  }
  app.quit();
});
