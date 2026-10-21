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
