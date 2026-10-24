import { contextBridge, ipcRenderer } from "electron";

type Unsubscribe = () => void;

contextBridge.exposeInMainWorld("kinetic", {
  onMessage(cb: (message: unknown) => void): Unsubscribe {
    const handler = (_e: unknown, message: unknown) => cb(message);
    ipcRenderer.on("engine:message", handler);
    return () => ipcRenderer.removeListener("engine:message", handler);
  },
  onStatus(cb: (status: { connected: boolean }) => void): Unsubscribe {
    const handler = (_e: unknown, status: { connected: boolean }) => cb(status);
    ipcRenderer.on("engine:status", handler);
    return () => ipcRenderer.removeListener("engine:status", handler);
  },
  getStatus(): Promise<{ connected: boolean }> {
    return ipcRenderer.invoke("engine:getStatus");
  },
  send(message: unknown) {
    ipcRenderer.send("engine:send", message);
  },
  kernel: {
    install: (): Promise<void> => ipcRenderer.invoke("kernel:install"),
    uninstall: (): Promise<void> => ipcRenderer.invoke("kernel:uninstall"),
    getInstall: (): Promise<unknown> => ipcRenderer.invoke("kernel:getInstall"),
    onInstall(cb: (state: unknown) => void): Unsubscribe {
      const handler = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("kernel:install", handler);
      return () => ipcRenderer.removeListener("kernel:install", handler);
    },
  },
  startup: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke("app:getStartup"),
    repair: (): Promise<unknown> => ipcRenderer.invoke("app:repairStartup"),
    openWindowsSettings: (): Promise<void> => ipcRenderer.invoke("app:openStartupSettings"),
  },
  engine: {
    start: (): Promise<void> => ipcRenderer.invoke("engine:start"),
    stop: (): Promise<void> => ipcRenderer.invoke("engine:stop"),
  },
  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke("win:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("win:toggleMaximize"),
    close: (): Promise<void> => ipcRenderer.invoke("win:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("win:isMaximized"),
    onMaximized(cb: (maximized: boolean) => void): Unsubscribe {
      const handler = (_e: unknown, m: boolean) => cb(m);
      ipcRenderer.on("win:maximized", handler);
      return () => ipcRenderer.removeListener("win:maximized", handler);
    },
  },
  pickProgram(): Promise<string | null> {
    return ipcRenderer.invoke("app:pickProgram");
  },
  exportSettings(text: string): Promise<string | null> {
    return ipcRenderer.invoke("app:exportSettings", text);
  },
  importSettings(): Promise<{ cancelled?: boolean; error?: string; config?: unknown }> {
    return ipcRenderer.invoke("app:importSettings");
  },
  showLog(): Promise<void> {
    return ipcRenderer.invoke("app:showLog");
  },
  openIssue(title: string, body: string): Promise<{ opened: boolean; truncated?: boolean; reason?: string }> {
    return ipcRenderer.invoke("app:openIssue", title, body);
  },
  getVersion(): Promise<string> {
    return ipcRenderer.invoke("app:getVersion");
  },
  updates: {
    getStatus: () => ipcRenderer.invoke("updates:getStatus"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    onStatus(cb: (status: unknown) => void): Unsubscribe {
      const handler = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on("updates:status", handler);
      return () => ipcRenderer.removeListener("updates:status", handler);
    },
  },
  pickFile(): Promise<string | null> {
    return ipcRenderer.invoke("app:pickFile");
  },
  getAppSettings() {
    return ipcRenderer.invoke("app:getSettings");
  },
  setAppSettings(patch: unknown) {
    return ipcRenderer.invoke("app:setSettings", patch);
  },
});
