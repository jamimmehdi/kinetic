import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Named pipe the Rust engine listens on. Messages are one JSON object per line. */
const PIPE_PATH = "\\\\.\\pipe\\kinetic-engine";
const RETRY_MS = 1500;
/** Failed connection attempts before the app starts the engine itself. */
const START_ENGINE_AFTER = 2;

interface AppSettings {
  startWithWindows: boolean;
  minimizeToTray: boolean;
  /** Check for new versions on startup and every few hours. */
  autoUpdate: boolean;
  /** The first-launch guide has been completed or skipped. */
  setupDone: boolean;
  /** Step aside for games with kernel anti-cheat (Valorant and similar). */
  gameGuard: boolean;
  /** Record what Kinetic does (and whether it worked) to a log file. */
  activityLog: boolean;
  /** Release the mouse when Windows refuses the input Kinetic sends. */
  blockedFailsafe: boolean;
  /** Let the Raw Accel driver do movement processing (works where injected input is refused). */
  kernelMode: boolean;
}

const DEFAULT_SETTINGS: AppSettings = { startWithWindows: false, minimizeToTray: true, autoUpdate: true, setupDone: false, gameGuard: true, activityLog: false, blockedFailsafe: true, kernelMode: false };

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let socket: net.Socket | null = null;
let buffer = "";
let failedAttempts = 0;
let spawnedEngine = false;
let quitting = false;
let connected = false;
let settings: AppSettings = { ...DEFAULT_SETTINGS };

// ---- settings -----------------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings(): AppSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<AppSettings>;
    return {
      startWithWindows: parsed.startWithWindows === true,
      minimizeToTray: parsed.minimizeToTray !== false,
      autoUpdate: parsed.autoUpdate !== false,
      setupDone: parsed.setupDone === true,
      gameGuard: parsed.gameGuard !== false,
      activityLog: parsed.activityLog === true,
      blockedFailsafe: parsed.blockedFailsafe !== false,
      kernelMode: parsed.kernelMode === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    // Not being able to save settings must never stop the app.
  }
}

// ---- start with Windows ------------------------------------------------------------------------
// Electron's own login-item call proved unreliable (no entry was left behind), so the Run key is
// written directly. The value is the installed program plus --hidden, so Kinetic opens in the tray.

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const RUN_NAME = "Kinetic";

function reg(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? "") }));
  });
}

type StartupStatus =
  | { state: "dev" }
  | { state: "off" }
  | { state: "ok" }
  | { state: "missing" }
  | { state: "wrong-program" }
  | { state: "disabled" };

/** Whether Kinetic will really start at sign-in, read back from Windows. */
async function startupStatus(): Promise<StartupStatus> {
  if (!app.isPackaged) return { state: "dev" };
  const run = await reg(["query", RUN_KEY, "/v", RUN_NAME]);
  const registered = run.ok && run.out.toLowerCase().includes(process.execPath.toLowerCase());
  if (!settings.startWithWindows) return registered ? { state: "ok" } : { state: "off" };
  if (!run.ok) return { state: "missing" };
  if (!registered) return { state: "wrong-program" };
  // Windows keeps a switch for each startup app: Settings → Apps → Startup. First byte 03 means off.
  const approved = await reg(["query", APPROVED_KEY, "/v", RUN_NAME]);
  if (approved.ok && /REG_BINARY\s+03/i.test(approved.out)) return { state: "disabled" };
  return { state: "ok" };
}

/** Makes the sign-in launch match the setting: adds or removes the Run entry. */
async function applyLoginItem(): Promise<void> {
  if (!app.isPackaged) return;
  // Clear anything Electron's own call may have left, so there is only ever one entry.
  app.setLoginItemSettings({ openAtLogin: false });
  if (settings.startWithWindows) {
    await reg(["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", `"${process.execPath}" --hidden`, "/f"]);
    // A switch left off in Windows' startup settings is the user's call, so leave it alone.
  } else {
    await reg(["delete", RUN_KEY, "/v", RUN_NAME, "/f"]);
  }
}

// ---- engine connection --------------------------------------------------------------------------

function toRenderer(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function enginePath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "engine", "kinetic-engine.exe")]
    : [
        path.join(app.getAppPath(), "..", "engine", "target", "release", "kinetic-engine.exe"),
        path.join(app.getAppPath(), "..", "engine", "target", "debug", "kinetic-engine.exe"),
      ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Starts the engine as its own process, so it keeps working when the window is closed. */
function startEngine() {
  const exe = enginePath();
  if (!exe || spawnedEngine) return;
  spawnedEngine = true;
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { spawnedEngine = false; });
    child.unref();
  } catch {
    spawnedEngine = false;
  }
}

function connectToEngine() {
  const s = net.connect(PIPE_PATH);
  socket = s;

  s.on("connect", () => {
    failedAttempts = 0;
    buffer = "";
    connected = true;
    toRenderer("engine:status", { connected: true });
    send({ cmd: "set_game_guard", enabled: settings.gameGuard });
    send({ cmd: "set_activity_log", enabled: settings.activityLog });
    send({ cmd: "set_failsafe", enabled: settings.blockedFailsafe });
    send({ cmd: "set_kernel_mode", enabled: settings.kernelMode });
    send({ cmd: "snapshot" });
  });

  s.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        toRenderer("engine:message", JSON.parse(line));
      } catch {
        // A malformed line from the engine is dropped, the stream keeps going.
      }
    }
  });

  const lost = () => {
    if (socket !== s) return;
    socket = null;
    connected = false;
    toRenderer("engine:status", { connected: false });
    if (quitting) return;
    failedAttempts += 1;
    // Nothing is listening: start the engine ourselves, and again every ~15 s if it keeps being gone.
    if (failedAttempts === START_ENGINE_AFTER || (failedAttempts > START_ENGINE_AFTER && failedAttempts % 10 === 0)) {
      spawnedEngine = false;
      startEngine();
    }
    setTimeout(connectToEngine, RETRY_MS);
  };
  s.on("close", lost);
  s.on("error", () => s.destroy());
}

function send(message: unknown) {
  if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}

// ---- window and tray ----------------------------------------------------------------------------

const iconPath = () => path.join(app.getAppPath(), "assets", "icon.png");

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 800,
    minWidth: 1500,
    minHeight: 700,
    backgroundColor: "#0E1013",
    title: "Kinetic",
    icon: fs.existsSync(iconPath()) ? iconPath() : undefined,
    autoHideMenuBar: true,
    show: !process.argv.includes("--hidden"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on("close", (e) => {
    // With "keep running in the tray" the close button only hides the window.
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => { win = null; });
  // A page that (re)loads missed whatever was sent before it was ready, so catch it up.
  win.webContents.on("did-finish-load", () => {
    toRenderer("engine:status", { connected });
    if (connected) send({ cmd: "snapshot" });
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function createTray() {
  if (!fs.existsSync(iconPath())) return;
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip("Kinetic");
  const menu = Menu.buildFromTemplate([
    { label: "Open Kinetic", click: showWindow },
    { label: "Pause remapping", type: "checkbox", click: (item) => send({ cmd: "set_paused", paused: item.checked }) },
    { type: "separator" },
    {
      label: "Quit Kinetic and stop remapping",
      click: () => {
        quitting = true;
        send({ cmd: "quit" });
        setTimeout(() => app.quit(), 150);
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
}

// ---- app wiring ---------------------------------------------------------------------------------

ipcMain.on("engine:send", (_e, message) => send(message));
ipcMain.handle("engine:getStatus", () => ({ connected }));
ipcMain.handle("app:getSettings", () => settings);
ipcMain.handle("app:setSettings", (_e, patch: Partial<AppSettings>) => {
  const pick = (key: keyof AppSettings) => (typeof patch[key] === "boolean" ? (patch[key] as boolean) : settings[key]);
  settings = {
    startWithWindows: pick("startWithWindows"),
    minimizeToTray: pick("minimizeToTray"),
    autoUpdate: pick("autoUpdate"),
    setupDone: pick("setupDone"),
    gameGuard: pick("gameGuard"),
    activityLog: pick("activityLog"),
    blockedFailsafe: pick("blockedFailsafe"),
    kernelMode: pick("kernelMode"),
  };
  send({ cmd: "set_kernel_mode", enabled: settings.kernelMode });
  saveSettings();
  send({ cmd: "set_game_guard", enabled: settings.gameGuard });
  send({ cmd: "set_activity_log", enabled: settings.activityLog });
  send({ cmd: "set_failsafe", enabled: settings.blockedFailsafe });
  void applyLoginItem();
  return settings;
});
ipcMain.handle("app:getStartup", () => startupStatus());
ipcMain.handle("app:repairStartup", async () => {
  await applyLoginItem();
  return startupStatus();
});
ipcMain.handle("app:openStartupSettings", () => shell.openExternal("ms-settings:startupapps"));

// Backing up and restoring settings by hand. The page passes the settings as text; the engine checks
// and cleans them when they are imported.
ipcMain.handle("app:exportSettings", async (_e, text: unknown) => {
  if (typeof text !== "string" || text.length > 5_000_000) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const pick = await dialog.showSaveDialog({ title: "Save Kinetic settings", defaultPath: `kinetic-settings-${stamp}.json`, filters: [{ name: "Kinetic settings", extensions: ["json"] }] });
  if (pick.canceled || !pick.filePath) return null;
  fs.writeFileSync(pick.filePath, text, "utf8");
  return pick.filePath;
});
ipcMain.handle("app:importSettings", async () => {
  const pick = await dialog.showOpenDialog({ title: "Load Kinetic settings", properties: ["openFile"], filters: [{ name: "Kinetic settings", extensions: ["json"] }] });
  if (pick.canceled || !pick.filePaths[0]) return { cancelled: true };
  try {
    const size = fs.statSync(pick.filePaths[0]).size;
    if (size > 5_000_000) return { error: "That file is too large to be a Kinetic settings file." };
    const config = JSON.parse(fs.readFileSync(pick.filePaths[0], "utf8"));
    if (!config || typeof config !== "object" || !Array.isArray(config.profiles)) return { error: "That file does not look like Kinetic settings." };
    return { config };
  } catch {
    return { error: "That file could not be read as settings." };
  }
});
// ---- Raw Accel (kernel mode) -----------------------------------------------------------------------
// Raw Accel is a separate, MIT-licensed, Microsoft-signed mouse driver (github.com/RawAccelOfficial/rawaccel).
// The app downloads the official release, checks it against a pinned hash and runs its own installer,
// which asks Windows for administrator approval and needs a restart. Nothing here is silent.

const RAW_ACCEL = {
  version: "1.7.1",
  url: "https://github.com/RawAccelOfficial/rawaccel/releases/download/v1.7.1/RawAccel_v1.7.1.zip",
  sha256: "770fe3ae0919ca3c4d412f58c985eb27f5434decad809f7e8206de4e8852eec4",
};

type KernelInstall =
  | { state: "idle" }
  | { state: "downloading" | "verifying" | "extracting" | "installing" | "removing" }
  | { state: "done"; restart: boolean }
  | { state: "error"; message: string };

let kernelInstall: KernelInstall = { state: "idle" };
const setKernelInstall = (s: KernelInstall) => {
  kernelInstall = s;
  toRenderer("kernel:install", s);
};

function rawAccelDir() {
  return path.join(app.getPath("appData"), "Kinetic", "rawaccel");
}

/** Downloads `url` to `dest`, following the redirects GitHub uses, and returns the file's SHA-256. */
function download(url: string, dest: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return reject(new Error("only https downloads are allowed"));
    https
      .get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error("too many redirects"));
          return resolve(download(new URL(res.headers.location, u).toString(), dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download failed (HTTP ${res.statusCode})`));
        }
        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(dest);
        res.on("data", (c) => hash.update(c));
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(hash.digest("hex"))));
        out.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Runs a PowerShell snippet. Paths travel in environment variables, never in the command text. */
function powershell(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim().slice(0, 300))) : resolve()),
    );
  });
}

/** Runs one of Raw Accel's own programs with administrator rights. Windows shows its approval prompt. */
function runElevated(exe: string, cwd: string): Promise<void> {
  // Raw Accel's installer finds the driver by a relative path, and an elevated start does not keep the
  // working directory, so go through cmd to change into the folder first. Its window waits for a key
  // press, which is how the user sees whether it worked.
  return powershell(
    "$a = '/c cd /d \"' + $env:KCWD + '\" && \"' + $env:KEXE + '\"'; $p = Start-Process -FilePath $env:ComSpec -ArgumentList $a -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
    { KEXE: exe, KCWD: cwd },
  );
}

/** Where the installer puts the driver. Its presence is the proof that the install worked. */
function installedDriverPath() {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "rawaccel.sys");
}

async function installRawAccel() {
  if (["downloading", "verifying", "extracting", "installing", "removing"].includes(kernelInstall.state)) return;
  const tmp = path.join(os.tmpdir(), "KineticRawAccel");
  const zip = path.join(tmp, `RawAccel_v${RAW_ACCEL.version}.zip`);
  const staging = path.join(tmp, "x");
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    setKernelInstall({ state: "downloading" });
    const digest = await download(RAW_ACCEL.url, zip);
    setKernelInstall({ state: "verifying" });
    if (digest !== RAW_ACCEL.sha256) throw new Error("the downloaded file does not match the expected checksum, so it was not used");
    setKernelInstall({ state: "extracting" });
    await powershell("Expand-Archive -LiteralPath $env:KZIP -DestinationPath $env:KDEST -Force", { KZIP: zip, KDEST: staging });
    const src = path.join(staging, "RawAccel");
    const dest = rawAccelDir();
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    for (const f of ["installer.exe", "writer.exe", "wrapper.dll", "Newtonsoft.Json.dll", path.join("driver", "rawaccel.sys")]) {
      if (!fs.existsSync(path.join(dest, f))) throw new Error(`the download is missing ${f}`);
    }
    setKernelInstall({ state: "installing" });
    await runElevated(path.join(dest, "installer.exe"), dest);
    if (!fs.existsSync(installedDriverPath())) {
      throw new Error("the installer did not put the driver in Windows. If you saw its window, it says why; if no approval prompt appeared, try again");
    }
    setKernelInstall({ state: "done", restart: true });
  } catch (e) {
    setKernelInstall({ state: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    send({ cmd: "kernel_refresh" });
  }
}

async function uninstallRawAccel() {
  const exe = path.join(rawAccelDir(), "uninstaller.exe");
  if (!fs.existsSync(exe)) return setKernelInstall({ state: "error", message: "the Raw Accel uninstaller is not on this PC" });
  try {
    setKernelInstall({ state: "removing" });
    await runElevated(exe, rawAccelDir());
    setKernelInstall(fs.existsSync(installedDriverPath())
      ? { state: "error", message: "the driver is still in Windows. If you saw the uninstaller's window, it says why" }
      : { state: "done", restart: true });
  } catch (e) {
    setKernelInstall({ state: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    send({ cmd: "kernel_refresh" });
  }
}

ipcMain.handle("kernel:install", () => void installRawAccel());
ipcMain.handle("kernel:uninstall", () => void uninstallRawAccel());
ipcMain.handle("kernel:getInstall", () => kernelInstall);

// Shows the activity log file in Explorer (or its folder if nothing was logged yet).
ipcMain.handle("app:showLog", () => {
  const file = path.join(app.getPath("appData"), "Kinetic", "activity.log");
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else void shell.openPath(path.dirname(file));
});
ipcMain.handle("app:pickFile", async () => {
  const options = { title: "Choose a program", properties: ["openFile" as const], filters: [{ name: "Programs", extensions: ["exe", "lnk", "bat", "cmd"] }, { name: "All files", extensions: ["*"] }] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

// ---- updates ------------------------------------------------------------------------------------

type UpdateStatus =
  | { state: "dev" }
  | { state: "unconfigured" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

let updateStatus: UpdateStatus = { state: "idle" };
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function setUpdateStatus(next: UpdateStatus) {
  updateStatus = next;
  toRenderer("updates:status", next);
}

/** Where releases are published, from package.json ("kinetic.updates"): a GitHub repo or a plain URL. */
function updateFeed(): { provider: "github"; owner: string; repo: string } | { provider: "generic"; url: string } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    const u = pkg?.kinetic?.updates;
    if (u?.provider === "github" && u.owner && u.repo) return { provider: "github", owner: String(u.owner), repo: String(u.repo) };
    if (u?.provider === "generic" && typeof u.url === "string" && /^https:\/\//.test(u.url)) return { provider: "generic", url: u.url };
  } catch {
    // No readable package.json means no feed.
  }
  return null;
}

function setupUpdater() {
  if (!app.isPackaged) {
    updateStatus = { state: "dev" };
    return;
  }
  const feed = updateFeed();
  if (!feed) {
    updateStatus = { state: "unconfigured" };
    return;
  }
  autoUpdater.setFeedURL(feed);
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => setUpdateStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => setUpdateStatus({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => setUpdateStatus({ state: "none" }));
  autoUpdater.on("download-progress", (p) => setUpdateStatus({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => setUpdateStatus({ state: "ready", version: info.version }));
  autoUpdater.on("error", (e) => setUpdateStatus({ state: "error", message: String(e?.message ?? e).slice(0, 200) }));
  setTimeout(() => settings.autoUpdate && checkForUpdates(), 15_000);
  setInterval(() => settings.autoUpdate && checkForUpdates(), CHECK_EVERY_MS);
}

function checkForUpdates() {
  if (updateStatus.state === "dev" || updateStatus.state === "unconfigured") return;
  if (updateStatus.state === "downloading" || updateStatus.state === "checking") return;
  autoUpdater.checkForUpdates().catch((e) => setUpdateStatus({ state: "error", message: String(e?.message ?? e).slice(0, 200) }));
}

ipcMain.handle("app:getVersion", () => app.getVersion());

// "Request support for this mouse": open a prefilled GitHub issue. The address is built here from
// package.json, never taken from the page, and the user presses Submit themselves.
const ISSUE_URL_LIMIT = 6500;
ipcMain.handle("app:openIssue", async (_e, title: unknown, body: unknown) => {
  let repo: { owner?: string; repo?: string } | undefined;
  try {
    repo = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"))?.kinetic?.repo;
  } catch {
    repo = undefined;
  }
  if (!repo?.owner || !repo.repo || !/^[A-Za-z0-9_.-]+$/.test(repo.owner) || !/^[A-Za-z0-9_.-]+$/.test(repo.repo)) return { opened: false, reason: "no-repo" };
  const t = String(title ?? "").slice(0, 200);
  const full = String(body ?? "").slice(0, 200_000);
  clipboard.writeText(full);
  const base = `https://github.com/${repo.owner}/${repo.repo}/issues/new?labels=mouse-support&title=${encodeURIComponent(t)}&body=`;
  let text = full;
  let truncated = false;
  while (base.length + encodeURIComponent(text).length > ISSUE_URL_LIMIT && text.length > 0) {
    text = text.slice(0, Math.floor(text.length * 0.8));
    truncated = true;
  }
  if (truncated) text += "\n\n[Report cut to fit. The full report is on your clipboard: paste it here.]";
  await shell.openExternal(base + encodeURIComponent(text));
  return { opened: true, truncated };
});
ipcMain.handle("updates:getStatus", () => updateStatus);
ipcMain.handle("updates:check", () => checkForUpdates());
ipcMain.handle("updates:download", () => {
  if (updateStatus.state === "available") autoUpdater.downloadUpdate().catch((e) => setUpdateStatus({ state: "error", message: String(e?.message ?? e).slice(0, 200) }));
});
ipcMain.handle("updates:install", () => {
  if (updateStatus.state !== "ready") return;
  // The installer replaces the engine program too, so stop the engine first.
  quitting = true;
  send({ cmd: "quit" });
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 400);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    settings = loadSettings();
    void applyLoginItem();
    setupUpdater();
    createWindow();
    createTray();
    connectToEngine();
  });
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => {
    // Without the tray option the app ends with its window, and takes the engine with it.
    if (!settings.minimizeToTray) {
      send({ cmd: "quit" });
      app.quit();
    }
  });
}
