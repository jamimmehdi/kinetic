import { useEffect, useState } from "react";
import { avatarColor, Tag, Top } from "../ui";
import { DEFAULT_PROFILE, getProfile, newId, stageDpi, withProfile, type EngineState, type Profile } from "../engine";

interface Props {
  engine: EngineState;
  profileId: string;
  onSelect(id: string): void;
  onEditButtons(): void;
  onEditPerformance(): void;
}

function chipFor(p: Profile): string {
  const [x, y] = stageDpi(p.perf, p.perf.active_stage);
  return x === y ? `${x}` : `${x} / ${y}`;
}

export function ProfilesScreen({ engine, profileId, onSelect, onEditButtons, onEditPerformance }: Props) {
  const { config, activeProfile } = engine;
  const profile = getProfile(config, profileId);
  const isDefault = profile.id === DEFAULT_PROFILE;
  const perf = profile.perf;

  // Text fields keep local state and save when the user leaves them, so the engine is not
  // rewritten (and the config file saved) on every keystroke.
  const [name, setName] = useState(profile.name);
  const [app, setApp] = useState(profile.app ?? "");
  useEffect(() => {
    setName(profile.name);
    setApp(profile.app ?? "");
  }, [profile.id, profile.name, profile.app]);

  useEffect(() => {
    engine.requestApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveName() {
    const next = name.trim() || "Untitled";
    if (next !== profile.name) engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, name: next })));
  }

  function saveApp() {
    const next = app.trim().toLowerCase();
    if (next !== (profile.app ?? "")) {
      engine.setConfig(withProfile(config, profile.id, (p) => ({ ...p, app: next || null })));
    }
  }

  function addProfile() {
    const id = newId("p");
    const base = getProfile(config, DEFAULT_PROFILE);
    // A new profile starts with the Default profile's sensitivity settings and no remaps.
    const perfCopy = JSON.parse(JSON.stringify(base.perf)) as Profile["perf"];
    engine.setConfig({ ...config, profiles: [...config.profiles, { id, name: "New profile", app: null, mappings: [], shift_mappings: [], perf: perfCopy }] });
    onSelect(id);
  }

  function removeProfile() {
    if (isDefault) return;
    engine.setConfig({ ...config, profiles: config.profiles.filter((p) => p.id !== profile.id) });
    onSelect(DEFAULT_PROFILE);
  }

  const shiftButton = [...profile.mappings, ...getProfile(config, DEFAULT_PROFILE).mappings].find((m) => m.action.type === "shift");
  const [x, y] = stageDpi(perf, perf.active_stage);
  const measured = engine.telemetry && engine.telemetry.hz > 0 ? engine.telemetry.hz : 0;

  return (
    <>
      <Top title="Profiles" sub="Each profile bundles buttons, sensitivity and macros, and can follow an app. Anything a profile leaves unmapped uses the Default profile.">
        <button className="btn" type="button" onClick={addProfile}>New profile</button>
      </Top>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gridAutoRows: "170px", gap: 16, alignContent: "start", overflow: "auto" }}>
          {config.profiles.map((p) => (
            <button key={p.id} type="button" className={`tile ${p.id === profile.id ? "sel" : ""}`} aria-pressed={p.id === profile.id} onClick={() => onSelect(p.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%" }}>
                <span className="av" style={{ background: avatarColor(p.id) }}>{(p.name || "?").charAt(0).toUpperCase()}</span>
                {p.id === activeProfile && <Tag kind="all">Active now</Tag>}
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{p.name}</div>
                <div className="sub">{p.app ?? (p.id === DEFAULT_PROFILE ? "Everything else" : "Not linked to an app")}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="chip small num">{chipFor(p)}</span>
                {p.shift_mappings.length > 0 && <span className="chip small">Shift layer</span>}
                {p.mappings.length > 0 && <span className="chip small">{p.mappings.length} remap{p.mappings.length === 1 ? "" : "s"}</span>}
              </div>
            </button>
          ))}
          <button type="button" className="tile add" onClick={addProfile}>+ Link an app</button>
        </div>

        <div className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 6, overflow: "auto" }}>
          <input
            className="input title-input"
            aria-label="Profile name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />

          <div className="lbl" style={{ marginTop: 10 }}>Trigger</div>
          {isDefault ? (
            <div className="set"><span>When no other profile matches</span><span className="sub">Always</span></div>
          ) : (
            <>
              <div className="set">
                <label htmlFor="papp">When app is in front</label>
                <input
                  id="papp"
                  className="input num"
                  style={{ maxWidth: 220, textAlign: "right" }}
                  list="running-apps"
                  value={app}
                  placeholder="valorant.exe"
                  onChange={(e) => setApp(e.target.value)}
                  onBlur={saveApp}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <datalist id="running-apps">{engine.apps.map((a) => <option key={a} value={a} />)}</datalist>
              </div>
              <div className="set"><span>Switch back when closed</span><span className="sub">Automatic</span></div>
            </>
          )}

          <div className="lbl" style={{ marginTop: 14 }}>Applies</div>
          <div className="set"><span>DPI stages</span><span className="num sub">{perf.stages.map((s) => s.dpi).join(" · ")}</span></div>
          <div className="set"><span>Independent X / Y</span><span className="num sub">{perf.independent_xy ? `${x} / ${y}` : "Off"}</span></div>
          <div className="set"><span>Acceleration</span><span className="num sub">{perf.accel.mode === "off" ? "Off" : perf.accel.mode}</span></div>
          <div className="set">
            <span>Polling rate</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="num sub">{measured ? `${measured} Hz` : "Measured only"}</span>
              <Tag kind="dev">Supported devices</Tag>
            </span>
          </div>
          <div className="set">
            <span>Button map</span>
            <span className="sub">{shiftButton ? `Shift layer on button ${shiftButton.button}` : `${profile.mappings.length} remap${profile.mappings.length === 1 ? "" : "s"}`}</span>
          </div>

          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={onEditButtons}>Edit buttons</button>
            <button className="btn2" type="button" style={{ height: 40 }} onClick={onEditPerformance}>Edit performance</button>
            {!isDefault && <button className="btn2" type="button" style={{ height: 40 }} onClick={removeProfile}>Delete</button>}
          </div>
        </div>
      </div>
    </>
  );
}
