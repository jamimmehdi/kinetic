import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DeviceInfo, EngineState } from "./engine";

/** What the setup learned about one mouse: the button that changes DPI and the DPI of each stage. */
export interface DpiCalibration {
  /** The mouse's DPI button, or null when it has none the app can see. */
  button: number | null;
  /** DPI of each stage, in the order the button cycles through them. */
  stages: number[];
}

export interface TrackedDpi {
  device: DeviceInfo;
  /** Zero-based stage the mouse is believed to be on. */
  stage: number;
  stages: number;
  dpi: number;
}

export interface DeviceDpi {
  calibrations: Readonly<Record<string, DpiCalibration>>;
  tracked: TrackedDpi | null;
  save(device: DeviceInfo, cal: DpiCalibration): void;
  clear(device: DeviceInfo): void;
}

export const DeviceDpiContext = createContext<DeviceDpi | null>(null);
export const useDeviceDpiContext = () => useContext(DeviceDpiContext);

const CAL_KEY = "kinetic.deviceDpi";
const STAGE_KEY = "kinetic.deviceDpiStage";

export const calKey = (d: Pick<DeviceInfo, "vid" | "pid">) => `${d.vid.toString(16)}:${d.pid.toString(16)}`;

function read<T>(key: string): Record<string, T> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembering the calibration is annoying but harmless.
  }
}

/**
 * Follows a mouse's DPI button on any brand: the setup measured each stage once, so every press of
 * the DPI button afterwards moves to the next stage and its DPI is known without asking the mouse.
 */
export function useDeviceDpi(engine: EngineState): DeviceDpi {
  const [calibrations, setCalibrations] = useState(() => read<DpiCalibration>(CAL_KEY));
  const [stages, setStages] = useState(() => read<number>(STAGE_KEY));
  const { lastButton, devices, hardware } = engine;

  // A press of a calibrated mouse's DPI button moves to its next stage.
  useEffect(() => {
    if (!lastButton?.down) return;
    const device = devices.find((d) => d.id === lastButton.device);
    const cal = device && calibrations[calKey(device)];
    if (!device || !cal || cal.button !== lastButton.button || cal.stages.length < 2) return;
    const key = calKey(device);
    setStages((prev) => {
      const next = { ...prev, [key]: ((prev[key] ?? 0) + 1) % cal.stages.length };
      write(STAGE_KEY, next);
      return next;
    });
    // Only a new button event may move the stage on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastButton?.n]);

  const save = useCallback((device: DeviceInfo, cal: DpiCalibration) => {
    const key = calKey(device);
    setCalibrations((prev) => {
      const next = { ...prev, [key]: cal };
      write(CAL_KEY, next);
      return next;
    });
    // Calibration ends on the first stage again, which is where the mouse is now.
    setStages((prev) => {
      const next = { ...prev, [key]: 0 };
      write(STAGE_KEY, next);
      return next;
    });
  }, []);

  const clear = useCallback((device: DeviceInfo) => {
    const key = calKey(device);
    setCalibrations((prev) => {
      const { [key]: _gone, ...rest } = prev;
      void _gone;
      write(CAL_KEY, rest);
      return rest;
    });
  }, []);

  // The calibrated mouse that was used last, else the first calibrated one. A mouse the engine can
  // read directly (Razer) never needs this.
  const tracked = useMemo<TrackedDpi | null>(() => {
    if (hardware?.connected) return null;
    const fromEvent = lastButton && devices.find((d) => d.id === lastButton.device && calibrations[calKey(d)]);
    const device = fromEvent || devices.find((d) => calibrations[calKey(d)]);
    if (!device) return null;
    const cal = calibrations[calKey(device)];
    if (!cal || cal.stages.length === 0) return null;
    const stage = Math.min(stages[calKey(device)] ?? 0, cal.stages.length - 1);
    return { device, stage, stages: cal.stages.length, dpi: cal.stages[stage] };
  }, [calibrations, stages, devices, lastButton, hardware]);

  return useMemo(() => ({ calibrations, tracked, save, clear }), [calibrations, tracked, save, clear]);
}
