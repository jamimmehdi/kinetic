// Takes the screenshots used in the README from the dev server (mock engine).
// Usage: SHOOT_OUT=<dir> electron scripts/shoot-docs.js   (vite must be running on :5173)
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.SHOOT_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => fs.appendFileSync(path.join(out, "shoot.log"), m + "\n");

const PAGE = `
  window.__q = (sel, text) => { const els = [...document.querySelectorAll(sel)]; return text ? els.find((e) => e.textContent.trim() === text || e.textContent.trim().startsWith(text)) : els[0]; };
  window.__click = (sel, text) => { const el = __q(sel, text); if (!el) throw new Error("no " + sel + " " + (text || "")); if (typeof el.click === "function") el.click(); else el.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
  window.__set = (sel, v) => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
  window.__nav = (n) => document.querySelector('[aria-label="' + n + '"]').click();
  window.__key = (k, ms) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k })); return new Promise((r) => setTimeout(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: k })); r(); }, ms || 120)); };
  0;
`;

async function session(query, theme, fn) {
  const win = new BrowserWindow({ width: 1500, height: 900, show: false, useContentSize: true, webPreferences: { sandbox: true } });
  await win.loadURL("http://127.0.0.1:5173/" + query);
  const run = async (code) => {
    try { return await win.webContents.executeJavaScript(code); } catch (e) { log("FAILED: " + code.trim().slice(0, 100) + " :: " + e); throw e; }
  };
  await run(`localStorage.setItem("kinetic.theme", "${theme}"); document.documentElement.dataset.theme = "${theme}";`);
  await win.webContents.reload(); await sleep(900);
  await run(PAGE);
  await sleep(700);
  const shot = async (name) => {
    await sleep(350);
    fs.writeFileSync(path.join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
    log("shot " + name);
  };
  await fn(run, shot, win);
  win.destroy();
}

app.on("window-all-closed", () => {}); // sessions close their window before the next one opens
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    // 1. First launch: the setup guide.
    await session("", "dark", async (run, shot) => {
      await run(`localStorage.removeItem("kinetic.mock.setupDone")`);
    });
    await session("", "dark", async (run, shot) => {
      await shot("setup-1-welcome");
      await run(`__click("button", "Start")`); await sleep(400);
      for (const k of ["3", "4", "5", "6"]) { await run(`__key("${k}")`); await sleep(150); }
      await shot("setup-2-press-buttons");
      await run(`__key("7")`); await sleep(500);
      await run(`__set('[aria-label="Name for button 7"]', "Thumb grid")`); await sleep(100);
      await shot("setup-3-unknown-button");
      await run(`__click("button", "Add")`); await sleep(300);
      await run(`__click("button", "That's all of them")`); await sleep(400);
      await shot("setup-4-summary");
      await run(`__click("button", "Finish")`); await sleep(400);
    });

    // 2. The main screens with sample data.
    await session("", "dark", async (run, shot) => {
      await run(`__nav("Macros")`); await sleep(250);
      await run(`__click("button", "New macro")`); await sleep(250);
      for (const [type, value] of [["key_tap", "r"], ["delay", "100"], ["click", "left"], ["key_tap", "q"]]) {
        await run(`__set('[aria-label="Step type"]', "${type}")`); await sleep(250);
        await run(`__set('[aria-label="Step value"]', "${value}")`); await sleep(250);
        await run(`__click("button", "Add step")`); await sleep(350);
      }
      await shot("macros");
      await run(`__nav("Profiles")`); await sleep(250);
      await run(`__click("button", "New profile")`); await sleep(300);
      await run(`__set('[aria-label="Profile name"]', "Valorant FPS")`);
      await run(`document.querySelector('[aria-label="Profile name"]').dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`); await sleep(250);
      await run(`__set("#papp", "valorant.exe")`);
      await run(`document.querySelector("#papp").dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`); await sleep(250);
      await shot("profiles");
      await run(`__nav("Acceleration")`); await sleep(250);
      await run(`__click("button", "Sigmoid")`); await sleep(300);
      await shot("acceleration");
      await run(`__nav("Performance")`); await sleep(300);
      await shot("performance");
      await run(`__nav("Buttons")`); await sleep(300);
      await run(`__click('[aria-label^="Button 4"]')`); await sleep(250);
      await shot("buttons");
      await run(`__click("button", "Macro")`); await sleep(250);
      await shot("buttons-macro");
      await run(`__click("button", "Shift layer")`); await sleep(250);
      await shot("buttons-shift-layer");
      await run(`__nav("Dashboard")`); await sleep(300);
      await run(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }))`); await sleep(2500);
      await shot("dashboard");
      await run(`__nav("Settings")`); await sleep(300);
      await shot("settings");
    });

    // 3. Dashboard in the light theme.
    await session("", "light", async (run, shot) => {
      await run(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }))`); await sleep(2500);
      await shot("dashboard-light");
    });

    // 4. A mouse the engine cannot read directly: measure and calibrate DPI, support request.
    await session("?nohw", "dark", async (run, shot) => {
      await run(`__nav("Performance")`); await sleep(300);
      await shot("performance-generic-mouse");
      await run(`__click("button", "Measure it")`); await sleep(300);
      await shot("measure-1-start");
      await run(`__click("button", "Start")`); await sleep(1500);
      await shot("measure-2-moving");
      await run(`__click("button", "Done")`); await sleep(400);
      await shot("measure-3-result");
      await run(`__click("button", "Close")`); await sleep(300);
      await run(`__nav("Settings")`); await sleep(300);
      await run(`__click("button", "Calibrate")`); await sleep(300);
      await shot("calibrate-1-dpi-button");
      await run(`__key("6")`); await sleep(500);
      await shot("calibrate-2-measure");
      await run(`__click("button", "Cancel")`); await sleep(300);
      await run(`__click("button", "Request support")`); await sleep(600);
      await shot("support-request");
    });
  } catch (e) {
    log(String(e && e.stack || e));
  }
  app.quit();
});

