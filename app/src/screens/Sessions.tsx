import { useEffect, useMemo, useState } from "react";
import { Top } from "../ui";
import type { EngineState, LiveSession, SessionDetail, SessionSettings, SessionState, SessionSummary } from "../engine";

/** How each state looks on the timeline, and what it is called. */
const STATE: Record<SessionState, { label: string; color: string; note: string }> = {
  working: { label: "Working", color: "var(--ok)", note: "Kinetic was applying your settings" },
  standby: { label: "Running, nothing to apply", color: "var(--ac)", note: "Kinetic was running, but your settings needed no processing" },
  paused: { label: "Paused by you", color: "var(--mu)", note: "You paused the engine" },
  game_pause: { label: "Stepped aside for the game", color: "var(--wn)", note: "The engine's pause for games with anti-cheat was on" },
  blocked: { label: "Input blocked", color: "#d9534f", note: "Windows refused the input Kinetic sent" },
  kernel_error: { label: "Kernel mode not active", color: "#e07b39", note: "Kernel mode was on but the driver was not working" },
  offline: { label: "Kinetic was not running", color: "var(--bd)", note: "No record: Kinetic was closed or stopped" },
};
const ORDER: SessionState[] = ["working", "standby", "paused", "game_pause", "blocked", "kernel_error", "offline"];

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

const when = (t: number) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const stateMs = (s: SessionSummary): Record<SessionState, number> => ({
  working: s.working_ms, standby: s.standby_ms, paused: s.paused_ms, game_pause: s.game_pause_ms,
  blocked: s.blocked_ms, kernel_error: s.kernel_error_ms, offline: s.offline_ms,
});

interface Props {
  engine: EngineState;
}

/** A record of how Kinetic did while tracked apps (a game, say) were running. */
export function SessionsScreen({ engine }: Props) {
  const { sessions, liveSessions, sessionDetail, config } = engine;
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    engine.requestSessions();
    engine.requestApps();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected && sessions[0]) setSelected(sessions[0].id);
    if (selected && !sessions.some((s) => s.id === selected)) setSelected(sessions[0]?.id ?? null);
  }, [sessions, selected]);

  // Fetch the chosen session, and keep a live one fresh.
  const isLive = sessions.find((s) => s.id === selected)?.live ?? false;
  useEffect(() => {
    if (!selected) return;
    engine.requestSession(selected);
    if (!isLive) return;
    const timer = window.setInterval(() => engine.requestSession(selected), 5000);
    return () => window.clearInterval(timer);
  }, [selected, isLive]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishedAll = sessions;
  const totalMs = finishedAll.reduce((a, s) => a + s.duration_ms, 0);
  const workingMs = finishedAll.reduce((a, s) => a + s.working_ms, 0);
  const kernelMs = finishedAll.reduce((a, s) => a + s.kernel_ms, 0);
  const detail = sessionDetail && sessionDetail.id === selected ? sessionDetail : null;

  return (
    <>
      <Top title="Sessions" sub="Is Kinetic working while you play? Pick the apps to track and see, for every session, how long it worked and with which settings." />

      <div className="scroll-y" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 18 }}>
        {liveSessions.map((l) => <LiveBanner key={l.id} live={l} />)}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14, flex: "none" }}>
          <Total label="Sessions tracked" value={String(finishedAll.length)} sub={config.tracked.length ? `${config.tracked.length} app${config.tracked.length === 1 ? "" : "s"} tracked` : "No app tracked yet"} />
          <Total label="Time tracked" value={duration(totalMs)} sub="all sessions together" />
          <Total label="Kinetic working" value={totalMs ? `${pct(workingMs, totalMs)}%` : "–"} sub="of the time tracked" />
          <Total label="Kernel mode on" value={totalMs ? `${pct(kernelMs, totalMs)}%` : "–"} sub="of the time tracked" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 0.8fr) minmax(0, 2.2fr)", gap: 18, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            <TrackerCard engine={engine} />
            <div className="card" style={{ padding: "18px 18px 8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span className="lbl">Sessions</span>
                {sessions.some((s) => !s.live) && <button type="button" className="btn2" style={{ height: 30 }} onClick={() => engine.clearSessions()}>Clear history</button>}
              </div>
              {sessions.length === 0 && <div className="sub" style={{ padding: "8px 0 16px", lineHeight: 1.5 }}>No sessions yet. Add an app above, then start it. A session is recorded from the moment it opens until it closes.</div>}
              <div role="listbox" aria-label="Sessions" style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10 }}>
                {sessions.map((s) => <SessionRow key={s.id} s={s} on={s.id === selected} onClick={() => setSelected(s.id)} />)}
              </div>
            </div>
          </div>

          {detail ? <Detail d={detail} /> : (
            <div className="card" style={{ padding: 28, minHeight: 240 }}>
              <div className="sub" style={{ lineHeight: 1.6 }}>
                {sessions.length ? "Loading the session…" : "Once a tracked app has run, its session appears here with a timeline, a graph of your mouse activity and a list of what worked."}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Total({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card" style={{ padding: "16px 20px" }}>
      <div className="lbl">{label}</div>
      <div className="num" style={{ fontSize: 30, marginTop: 6 }}>{value}</div>
      <div className="sub" style={{ fontSize: 12 }}>{sub}</div>
    </div>
  );
}

function LiveBanner({ live }: { live: LiveSession }) {
  const st = STATE[live.state];
  return (
    <div className="card" style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 16, flex: "none", borderColor: st.color }} role="status">
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: st.color, flex: "none" }} aria-hidden="true" />
      <b>{live.name} is running</b>
      <span className="sub">for {duration(live.duration_ms)} · Kinetic: {st.label.toLowerCase()} · worked for {duration(live.working_ms)} so far</span>
    </div>
  );
}

function SessionRow({ s, on, onClick }: { s: SessionSummary; on: boolean; onClick(): void }) {
  const ms = stateMs(s);
  const worst = ORDER.filter((k) => k !== "working" && k !== "standby" && ms[k] > 0)[0];
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      onClick={onClick}
      style={{
        textAlign: "left", padding: "10px 12px", borderRadius: 10, border: 0, cursor: "pointer",
        background: on ? "var(--acs)" : "var(--sub)", boxShadow: on ? "inset 0 0 0 1px var(--ac)" : "none", color: "var(--tx)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{s.name}</b>
        {s.live ? <span style={{ color: "var(--ok)", fontSize: 12, fontWeight: 600 }}>LIVE</span> : <span className="num sub" style={{ fontSize: 12 }}>{duration(s.duration_ms)}</span>}
      </div>
      <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{when(s.started)}</div>
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8, background: "var(--bd)" }} aria-hidden="true">
        {ORDER.map((k) => ms[k] > 0 ? <span key={k} style={{ width: `${(ms[k] / Math.max(s.duration_ms, 1)) * 100}%`, background: STATE[k].color }} /> : null)}
      </div>
      <div className="sub" style={{ fontSize: 12, marginTop: 6 }}>
        {pct(s.working_ms, s.duration_ms)}% working{worst ? ` · ${STATE[worst].label.toLowerCase()} ${duration(ms[worst])}` : ""}
      </div>
    </button>
  );
}

/** A readable name for a program file, for example "Valorant" for VALORANT-Win64-Shipping.exe. */
export function niceName(file: string): string {
  const base = file
    .replace(/\.exe$/i, "")
    .replace(/[-_ ]?(win64|win32|x64|x86|shipping)\b/gi, "")
    .replace(/[-_]+$/g, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!base) return file;
  // ALL CAPS reads as shouting; a name like "Notepad" or "Valorant" is nicer.
  const text = base === base.toUpperCase() ? base.charAt(0) + base.slice(1).toLowerCase() : base === base.toLowerCase() ? base.charAt(0).toUpperCase() + base.slice(1) : base;
  return text.slice(0, 40);
}

/** Launchers that do not open a window of their own, and the program that does. */
const REAL_PROGRAM: Record<string, { exe: string; note: string }> = {
  "valorant.exe": { exe: "valorant-win64-shipping.exe", note: "VALORANT.exe is only the launcher, so Kinetic is tracking the game itself (VALORANT-Win64-Shipping.exe)." },
};

function TrackerCard({ engine }: { engine: EngineState }) {
  const { config, apps } = engine;
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const tracked = config.tracked;
  const VALORANT = "valorant-win64-shipping.exe";

  const add = (exe: string, name?: string) => {
    const e = exe.trim().toLowerCase();
    if (!e || tracked.some((t) => t.exe === e)) return;
    engine.setConfig({ ...config, tracked: [...tracked, { exe: e, name: (name ?? niceName(e)).slice(0, 40) }] });
    setText("");
  };

  // Opens Windows' own file picker, so any program can be chosen without knowing its file name.
  const browse = async () => {
    const path = await window.kinetic?.pickProgram?.();
    if (!path) return;
    const file = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
    if (!file.endsWith(".exe")) {
      setNote("Please choose a program (.exe).");
      return;
    }
    const real = REAL_PROGRAM[file];
    const exe = real?.exe ?? file;
    if (tracked.some((t) => t.exe === exe)) {
      setNote(`${niceName(exe)} is already tracked.`);
      return;
    }
    setNote(real?.note ?? "");
    add(exe, niceName(exe));
  };
  const remove = (exe: string) => engine.setConfig({ ...config, tracked: tracked.filter((t) => t.exe !== exe) });

  return (
    <div className="card" style={{ padding: "18px 18px 16px" }}>
      <div className="lbl" style={{ marginBottom: 8 }}>Tracked apps</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {tracked.length === 0 && <span className="sub" style={{ fontSize: 13 }}>Nothing tracked yet.</span>}
        {tracked.map((t) => (
          <span key={t.exe} className="chip on" style={{ gap: 8 }} title={t.exe}>
            {t.name}
            <button type="button" aria-label={`Stop tracking ${t.name}`} onClick={() => remove(t.exe)} style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
      <button type="button" className="btn" style={{ width: "100%", marginBottom: 10 }} onClick={browse} disabled={!window.kinetic?.pickProgram}>Choose a program…</button>
      {note && <div className="sub" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }} role="status">{note}</div>}
      <div className="sub" style={{ fontSize: 12, marginBottom: 6 }}>Or type its file name:</div>
      <form
        style={{ display: "flex", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          add(text);
        }}
      >
        <input className="input" list="tracked-apps" aria-label="App to track" placeholder="App name, for example game.exe" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <datalist id="tracked-apps">{apps.map((a) => <option key={a} value={a} />)}</datalist>
        <button className="btn2" type="submit">Add</button>
      </form>
      {!tracked.some((t) => t.exe === VALORANT) && (
        <button type="button" className="btn2" style={{ marginTop: 10, height: 32 }} onClick={() => add(VALORANT, "Valorant")}>Track Valorant</button>
      )}
      <div className="sub" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
        A session starts when the app opens a window and ends when it closes. For a game, choose the game itself, not its launcher.
      </div>
    </div>
  );
}

// ---- one session ------------------------------------------------------------------------------------------

function Detail({ d }: { d: SessionDetail }) {
  const end = d.ended ?? d.last_seen;
  const total = Math.max(end - d.started, 1);
  const ms = stateMs(d);
  const present = ORDER.filter((k) => ms[k] > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
      <div className="card" style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 650, margin: 0 }}>{d.name}</h2>
            <div className="sub" style={{ marginTop: 2 }}>
              {when(d.started)} to {d.ended ? clock(d.ended) : "now"} · {duration(total)}
              {d.late_start ? " · Kinetic opened after the app, so the real start is earlier" : ""}
            </div>
          </div>
          <div className="num" style={{ fontSize: 34, color: "var(--ok)" }}>
            {pct(d.working_ms, d.duration_ms)}% <span className="sub" style={{ fontSize: 13 }}>working</span>
          </div>
        </div>

        <Timeline d={d} total={total} />
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }} aria-label="Legend">
          {present.map((k) => (
            <span key={k} className="sub" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }} title={STATE[k].note}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: STATE[k].color, border: k === "offline" ? "1px dashed var(--mu)" : "none" }} />
              {STATE[k].label} · {duration(ms[k])}
            </span>
          ))}
        </div>
        {d.ended_by && <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>Ended: {d.ended_by.toLowerCase()}.</div>}
      </div>

      <div className="card" style={{ padding: "20px 24px" }}>
        <div className="lbl" style={{ marginBottom: 6 }}>Mouse activity</div>
        <ActivityChart d={d} total={total} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: 18 }}>
        <div className="card" style={{ padding: "18px 22px" }}>
          <div className="lbl" style={{ marginBottom: 6 }}>What worked</div>
          <Checks d={d} />
        </div>
        <div className="card" style={{ padding: "18px 22px" }}>
          <div className="lbl" style={{ marginBottom: 6 }}>Settings in use</div>
          <SettingsList d={d} />
        </div>
      </div>
    </div>
  );
}

const W = 760;

/** The whole session as one bar, coloured by what Kinetic was doing. */
function Timeline({ d, total }: { d: SessionDetail; total: number }) {
  const x = (t: number) => ((t - d.started) / total) * W;
  const marks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${W} 74`} width="100%" role="img" aria-label="Timeline of what Kinetic was doing during the session" style={{ marginTop: 16, display: "block" }}>
      <defs>
        <pattern id="offline-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" style={{ fill: "var(--sub)" }} />
          <path d="M0 0V6" style={{ stroke: "var(--mu)" }} strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height="34" rx="6" style={{ fill: "var(--sub)" }} />
      {d.segments.map(([state, from, to], i) => {
        const w = Math.max(x(to) - x(from), state === "offline" ? 1 : 0.8);
        return (
          <rect key={i} x={x(from)} y="0" width={w} height="34" fill={state === "offline" ? "url(#offline-hatch)" : STATE[state].color}>
            <title>{`${STATE[state].label}: ${clock(from)} to ${clock(to)} (${duration(to - from)})`}</title>
          </rect>
        );
      })}
      {d.notes.slice(1).map((n, i) => (
        <g key={i}>
          <path d={`M${x(n.t)} 34V44`} style={{ stroke: "var(--tx)" }} strokeWidth="1.5" />
          <circle cx={x(n.t)} cy="48" r="3.5" style={{ fill: "var(--tx)" }}><title>{`Settings changed at ${clock(n.t)}`}</title></circle>
        </g>
      ))}
      {marks.map((m) => (
        <text key={m} x={Math.min(Math.max(m * W, 14), W - 14)} y="70" textAnchor={m === 0 ? "start" : m === 1 ? "end" : "middle"} style={{ fill: "var(--mu)", fontSize: 11 }}>
          {clock(d.started + m * total)}
        </text>
      ))}
    </svg>
  );
}

/** Mouse movement over the session, in events per second, in ten second steps. */
function ActivityChart({ d, total }: { d: SessionDetail; total: number }) {
  const H = 150, L = 36, B = 22, T = 8;
  const rate = d.buckets.map(([t, moves]) => ({ t, v: moves / 10 }));
  const top = Math.max(100, ...rate.map((r) => r.v)) * 1.1;
  const x = (t: number) => L + ((t - d.started) / total) * (W - L);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const line = rate.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.t).toFixed(1)} ${y(r.v).toFixed(1)}`).join("");
  const area = rate.length ? `${line}L${x(rate[rate.length - 1].t).toFixed(1)} ${y(0)}L${x(rate[0].t).toFixed(1)} ${y(0)}Z` : "";
  const ticks = [0, 0.5, 1].map((f) => Math.round((top * f) / 10) * 10);

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Mouse movement events per second over the session" style={{ display: "block" }}>
        <g style={{ stroke: "var(--bd)" }}>{ticks.map((v) => <path key={v} d={`M${L} ${y(v)}H${W}`} />)}</g>
        {area && <path d={area} style={{ fill: "var(--acs)" }} />}
        {line && <path d={line} style={{ stroke: "var(--ac)" }} strokeWidth="1.6" fill="none" strokeLinejoin="round" />}
        {d.buckets.filter((b) => b[4] > 0).map((b) => (
          <rect key={b[0]} x={x(b[0])} y={T} width="3" height={H - T - B} fill="#d9534f" opacity="0.55"><title>{`Windows refused ${b[4]} of Kinetic's inputs at ${clock(b[0])}`}</title></rect>
        ))}
        <g style={{ fill: "var(--mu)", fontSize: 11 }}>
          {ticks.map((v) => <text key={v} x={L - 6} y={y(v) + 4} textAnchor="end">{v}</text>)}
          <text x={L} y={H - 4}>{clock(d.started)}</text>
          <text x={W} y={H - 4} textAnchor="end">{clock(d.started + total)}</text>
        </g>
      </svg>
      <div className="sub" style={{ fontSize: 12, marginTop: 4 }}>
        Mouse movement events per second. {d.buckets.some((b) => b[4] > 0) ? "Red bars mark times Windows refused input Kinetic tried to send. " : ""}
        A flat stretch means you were not moving the mouse, for example between rounds.
      </div>
    </>
  );
}

type Verdict = "ok" | "warn" | "bad" | "na";

function Check({ verdict, title, detail }: { verdict: Verdict; title: string; detail: string }) {
  const mark = { ok: "✓", warn: "!", bad: "✗", na: "–" }[verdict];
  const color = { ok: "var(--ok)", warn: "var(--wn)", bad: "#d9534f", na: "var(--mu)" }[verdict];
  return (
    <div style={{ display: "flex", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--bd)" }}>
      <span style={{ width: 22, height: 22, borderRadius: "50%", flex: "none", display: "grid", placeItems: "center", fontWeight: 700, color, background: "var(--sub)" }} aria-label={verdict}>{mark}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 550 }}>{title}</div>
        <div className="sub" style={{ fontSize: 12, marginTop: 1, lineHeight: 1.45 }}>{detail}</div>
      </div>
    </div>
  );
}

function Checks({ d }: { d: SessionDetail }) {
  const dur = Math.max(d.duration_ms, 1);
  const remapsOff = d.notes.some((n) => !n.settings.remaps);
  const kernelPct = pct(d.kernel_ms, dur);
  const accepted = d.sent > 0 ? pct(d.seen, d.sent) : null;

  return (
    <>
      {d.offline_ms === 0 && !d.late_start
        ? <Check verdict="ok" title="Kinetic ran the whole session" detail="It was running from the moment the app opened to the moment it closed." />
        : <Check verdict="warn" title="Kinetic did not cover the whole session" detail={d.late_start ? "Kinetic opened after the app, so the first part is not on record. Turn on Start with Windows so it is ready first." : `Kinetic was not running for ${duration(d.offline_ms)}.`} />}
      {d.working_ms >= dur * 0.95
        ? <Check verdict="ok" title="Your movement settings were applied" detail={`${pct(d.working_ms, dur)}% of the session (${duration(d.working_ms)}).`} />
        : d.working_ms === 0 && d.standby_ms > dur * 0.5
          ? <Check verdict="na" title="Nothing needed applying" detail="Your settings were neutral, so Kinetic had no movement to change." />
          : <Check verdict={d.working_ms > dur * 0.5 ? "warn" : "bad"} title="Your movement settings were applied part of the time" detail={`${pct(d.working_ms, dur)}% working. ${[d.game_pause_ms && `stepped aside ${duration(d.game_pause_ms)}`, d.blocked_ms && `input blocked ${duration(d.blocked_ms)}`, d.paused_ms && `paused ${duration(d.paused_ms)}`, d.kernel_error_ms && `kernel mode down ${duration(d.kernel_error_ms)}`].filter(Boolean).join(", ")}.`} />}
      {d.kernel_ms > 0
        ? <Check verdict="ok" title="Kernel mode (Raw Accel) was active" detail={`${kernelPct}% of the session. The driver processes movement where anti-cheat refuses injected input.`} />
        : <Check verdict="na" title="Kernel mode was off" detail="Movement was processed by Kinetic's own engine." />}
      {accepted === null
        ? <Check verdict="na" title="No input of Kinetic's own was sent" detail="Nothing was re-sent, so there is nothing for Windows to refuse." />
        : d.refused === 0 && accepted >= 98
          ? <Check verdict="ok" title="Windows accepted Kinetic's input" detail={`${accepted}% came back through Windows, none refused.`} />
          : <Check verdict="bad" title="Windows refused some of Kinetic's input" detail={`${d.refused} events refused and ${accepted}% of movement came back. Anti-cheat is likely blocking injected input here.`} />}
      <Check
        verdict={remapsOff ? "warn" : "ok"}
        title={remapsOff ? "Remaps and macros were off for part of the session" : "Remaps and macros were available"}
        detail={remapsOff ? "They are switched off while a protected game is in front, or when paused. Kernel mode does not carry them." : `${d.buttons} remapped button presses ran.`}
      />
      <Check verdict="na" title={d.settings_changes ? `Settings changed ${d.settings_changes} time${d.settings_changes === 1 ? "" : "s"}` : "Settings stayed the same"} detail={d.settings_changes ? "Each change is a dot under the timeline." : "Nothing was changed during the session."} />
    </>
  );
}

function describe(s: SessionSettings): [string, string][] {
  return [
    ["Profile", s.profile],
    ["DPI", s.dpi_x ? `${s.dpi_x}${s.dpi_y && s.dpi_y !== s.dpi_x ? ` / ${s.dpi_y}` : ""}` : "–"],
    ["Acceleration", s.accel],
    ["Angle snapping", s.snap ? `on, ${s.snap_degrees}°` : "off"],
    ["Smoothing", s.smoothing > 0 ? String(s.smoothing) : "off"],
    ["Precision zone", s.precision ? `below ${s.precision_below} at ${Math.round(s.precision_factor * 100)}%` : "off"],
    ["Speed limit", s.speed_limit > 0 ? String(s.speed_limit) : "off"],
    ["Rotation", s.rotation ? `${s.rotation}°` : "0°"],
    ["Kernel mode", s.kernel ? "on" : "off"],
    ["Remaps", s.remaps ? "available" : "off"],
  ];
}

function SettingsList({ d }: { d: SessionDetail }) {
  const first = d.notes[0]?.settings;
  const changes = useMemo(() => {
    const out: { t: number; what: string[] }[] = [];
    for (let i = 1; i < d.notes.length; i++) {
      const a = describe(d.notes[i - 1].settings), b = describe(d.notes[i].settings);
      const diff = b.flatMap(([k, v], j) => (a[j][1] !== v ? [`${k}: ${a[j][1]} → ${v}`] : []));
      if (diff.length) out.push({ t: d.notes[i].t, what: diff });
    }
    return out;
  }, [d.notes]);
  if (!first) return <div className="sub">No settings were recorded.</div>;

  return (
    <>
      {describe(first).map(([k, v]) => (
        <div key={k} className="row plain" style={{ minHeight: 30 }}>
          <span className="sub">{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
      {changes.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--bd)" }}>
          <div className="lbl" style={{ marginBottom: 4 }}>Changes during the session</div>
          {changes.map((c) => (
            <div key={c.t} style={{ fontSize: 12, padding: "3px 0" }}>
              <span className="num sub">{clock(c.t)}</span> {c.what.join(", ")}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
