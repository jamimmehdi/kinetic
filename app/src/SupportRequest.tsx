import { useEffect, useMemo, useState } from "react";
import type { DpiCalibration } from "./deviceDpi";
import type { EngineState } from "./engine";

interface Props {
  engine: EngineState;
  calibrations: Readonly<Record<string, DpiCalibration>>;
  onClose(): void;
}

/** Builds the support report and opens a prefilled GitHub issue. The user reviews and submits it. */
export function SupportRequest({ engine, calibrations, onClose }: Props) {
  const [version, setVersion] = useState("");
  const [result, setResult] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const { report } = engine;

  useEffect(() => {
    engine.requestReport();
    window.kinetic?.getVersion?.().then(setVersion).catch(() => {});
    // The report is requested once when the dialog opens.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => {
    if (!report) return "";
    const rows = report.devices.map((d) => {
      const vp = parseInt(d.vid, 16).toString(16) + ":" + parseInt(d.pid, 16).toString(16);
      const cal = calibrations[vp];
      return { ...d, dpi_calibration: cal ?? null };
    });
    return [
      "### What mouse is this?",
      "(Brand and model, for example the name on the box)",
      "",
      "### Report",
      "Made by Kinetic. It has hardware identifiers and button layout only: no keystrokes, file paths or account data.",
      "",
      "```json",
      JSON.stringify({ app: version, engine: report.engine, windows: report.windows, devices: rows }, null, 2),
      "```",
    ].join("\n");
  }, [report, calibrations, version]);

  const title = report?.devices[0] ? `Mouse support: ${report.devices[0].name} (${report.devices[0].vid}:${report.devices[0].pid})` : "Mouse support request";

  const open = async () => {
    const r = await window.kinetic?.openIssue?.(title, body);
    if (!r) setResult("Opening GitHub only works in the installed app.");
    else if (!r.opened) setResult("This build has no GitHub repository set. The report is copied; paste it where you want it sent.");
    else setResult(r.truncated ? "GitHub opened. The report is long, so it is on your clipboard: paste it into the issue." : "GitHub opened. Check the report and press Submit.");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch {
      setResult("Could not copy. Select the text and copy it by hand.");
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Request support for this mouse" style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: "min(720px, 94vw)", maxHeight: "88vh", padding: 28, display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ fontSize: 20, fontWeight: 650, margin: 0 }}>Request support for this mouse</h2>
        <div className="sub" style={{ lineHeight: 1.5 }}>
          This opens a GitHub issue with the details below so support for your mouse can be added in a later update. Nothing is sent
          until you press Submit on GitHub, and you can edit it first. You'll need a GitHub account.
        </div>
        <textarea
          className="input"
          readOnly
          aria-label="Report that will be sent"
          value={body || "Collecting…"}
          style={{ flex: 1, minHeight: 220, fontFamily: "var(--mono, monospace)", fontSize: 12, padding: 12, resize: "none" }}
        />
        {result && <div role="status" className="sub">{result}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="btn2" onClick={onClose}>Close</button>
          <button type="button" className="btn2" disabled={!body} onClick={copy}>{copied ? "Copied" : "Copy report"}</button>
          <button type="button" className="btn" disabled={!body} onClick={open}>Open GitHub issue</button>
        </div>
      </div>
    </div>
  );
}
