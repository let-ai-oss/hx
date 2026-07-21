import { useEffect, useRef, useState } from "react";
import { sleep, useApp } from "../store";
import { plural } from "../data";

interface Flash { text: string; ok: boolean; }
interface ResultLine { text: string; on: boolean; }

export function DeviceDetail() {
  const {
    view, goto, deviceName, setDeviceName, deviceConnected, setDeviceConnected,
    doctorOpen, setDoctorOpen, activeFolders,
  } = useApp();

  // Rename
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);
  const startRename = () => {
    setRenameVal(deviceName);
    setRenaming(true);
  };
  const endRename = (save: boolean) => {
    if (save) {
      const v = renameVal.trim();
      if (v) setDeviceName(v);
    }
    setRenaming(false);
  };

  // Update flow: checking never installs. Every status — check result, download
  // progress, verify/install/restart/reconnect, done — lives INSIDE the version
  // row's existing sub-line, so the row never jumps and reserves no whitespace.
  const [verVal, setVerVal] = useState("76.2.4");
  const [verSub, setVerSub] = useState<{ bar: number | null; text: string; ok: boolean }>({ bar: null, text: "stable channel", ok: false });
  const [updateNowVisible, setUpdateNowVisible] = useState(false);
  const [updating, setUpdating] = useState(false);
  const checkUpdates = () => {
    if (verVal === "76.3.0") {
      setVerSub({ bar: null, text: "You’re on the latest version.", ok: true });
      setTimeout(() => setVerSub({ bar: null, text: "stable channel · up to date", ok: false }), 4000);
      return;
    }
    setVerSub({ bar: null, text: "76.3.0 is available — nothing was installed yet.", ok: true });
    setUpdateNowVisible(true);
  };
  const runUpdate = async () => {
    setUpdating(true);
    for (let p = 0; p <= 100; p += 5) {
      setVerSub({ bar: p, text: `Downloading 76.3.0 (14.1 MB) — ${p}%`, ok: false });
      await sleep(55);
    }
    for (const [label, ms] of [["Verifying checksum…", 450], ["Installing…", 450], ["Restarting daemon…", 600], ["Reconnecting HX Client…", 700]] as [string, number][]) {
      setVerSub({ bar: 100, text: label, ok: false });
      await sleep(ms);
    }
    setVerVal("76.3.0");
    setUpdateNowVisible(false);
    setUpdating(false);
    setVerSub({ bar: null, text: "Just updated to 76.3.0 — daemon restarted, page reconnected.", ok: true });
  };

  // Connection
  const [connQualV, setConnQualV] = useState("Excellent — 26 ms · 13.3 MB/s");
  const [connQualVs, setConnQualVs] = useState<Flash>({ text: "probed from this device", ok: false });
  const subFlash = (set: (fn: (s: Flash) => Flash) => void, text: string) => {
    set(() => ({ text, ok: true }));
    setTimeout(() => set((s) => ({ ...s, ok: false })), 4000);
  };
  const testConnection = () => {
    setConnQualV("Excellent — 25 ms · 13.1 MB/s");
    subFlash(setConnQualVs, "probed just now — 3 pings + a 1 MiB download");
  };

  // Sync engine
  const [daemonRunning, setDaemonRunning] = useState(true);
  const [engState, setEngState] = useState("Idle — watching");
  const [engSub, setEngSub] = useState<Flash>({ text: "daemon running · pid 35071 · via shell hook", ok: false });
  const [lpV, setLpV] = useState("2 seconds ago");
  const [lpVs, setLpVs] = useState<Flash>({ text: "0 uploads · 0 errors", ok: false });
  const daemonOn = (on: boolean) => {
    setDaemonRunning(on);
    setEngState(on ? "Idle — watching" : "Stopped");
    setEngSub({
      text: on
        ? "daemon running · pid 35102 · via shell hook"
        : "daemon stopped — sessions still queue safely; start again from here any time",
      ok: false,
    });
  };
  const restartDaemon = () => {
    daemonOn(true);
    subFlash(setEngSub, "daemon restarted · pid 35102 · via shell hook");
  };
  const stopStart = () => {
    if (daemonRunning) {
      daemonOn(false);
    } else {
      daemonOn(true);
      subFlash(setEngSub, "daemon started · pid 35120 · via shell hook");
    }
  };
  const tick = () => {
    setLpV("just now");
    subFlash(setLpVs, "pass complete — 2 uploads · 0 errors");
  };
  const connToggle = () => {
    if (deviceConnected) {
      setDeviceConnected(false);
      daemonOn(false);
    } else {
      setDeviceConnected(true);
      daemonOn(true);
    }
  };

  // Sync Doctor (hx doctor sync) + retry (hx retry --blocked) + back-fill
  const [retryResult, setRetryResult] = useState<ResultLine>({ text: "", on: false });
  const [backfillResult, setBackfillResult] = useState<ResultLine>({ text: "", on: false });
  const flashResult = (set: (fn: (s: ResultLine) => ResultLine) => void, msg: string) => {
    set(() => ({ text: msg, on: true }));
    setTimeout(() => set((s) => ({ ...s, on: false })), 4500);
  };

  return (
    <section className={`view${view === "device" ? " active" : ""}`} id="view-device">
      <div className="kicker">System</div>
      <h1>Device Detail</h1>
      <p className="lede">Everything this device’s <code className="hx">hx</code> client is doing — friendly at a glance, specific enough to debug over a screen share.</p>

      <div className="panel">
        <h2>Identity</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">Name</span>
            <span id="devNameCell">{renaming
              ? <input className="renamein" id="renameInput" ref={renameRef} value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") endRename(true); if (e.key === "Escape") endRename(false); }} />
              : <span className="v devname">{deviceName}</span>}</span>
            <span id="renameActions" style={{ display: "flex", gap: 8 }}>{renaming
              ? <><button className="btn sm" id="renameSave" onClick={() => endRename(true)}>Save</button><button className="btn ghost sm" id="renameCancel" onClick={() => endRename(false)}>Cancel</button></>
              : <button className="btn ghost sm" id="renameBtn" onClick={startRename}>Rename</button>}</span>
          </div>
          <div className="frw"><span className="k">Platform</span><span><span className="v">Linux arm64</span><div className="vs">container · cgroup detected</div></span></div>
          <div className="frw">
            <span className="k"><code className="hx">hx</code> version</span>
            <span>
              <span className="v mono" id="verVal">{verVal}</span>
              <div className={`vs${verSub.ok ? " okv" : ""}`} id="verSub">{verSub.bar !== null && <span className="minibar"><i style={{ width: `${verSub.bar}%` }}></i></span>}{verSub.text}</div>
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost sm" id="updateBtn" onClick={checkUpdates}>Check for updates</button>
              <button className="btn sm" id="updateNowBtn" style={{ display: updateNowVisible ? "" : "none" }} disabled={updating} onClick={runUpdate}>Update to 76.3.0</button>
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">Status</span>
            <span>
              <span className="v" id="connStatusV">{deviceConnected ? "Connected" : "Not connected"}</span>
              <div className="vs" id="connStatusVs">{deviceConnected ? "as Johnny Orange · this device is approved" : "signed out — sessions stay on this machine until reconnected"}</div>
            </span>
            <button className={deviceConnected ? "btn danger sm" : "btn sm"} id="connToggleBtn" onClick={connToggle}>{deviceConnected ? "Disconnect…" : "Connect this device"}</button>
          </div>
          <div className="frw"><span className="k">Signed in via</span><span><span className="v">let.ai</span><div className="vs">beta environment</div></span></div>
          <div className="frw">
            <span className="k">Link quality</span>
            <span>
              <span className="v" id="connQualV">{connQualV}</span>
              <div className={`vs${connQualVs.ok ? " okv" : ""}`} id="connQualVs">{connQualVs.text}</div>
            </span>
            <button className="btn ghost sm" id="connTestBtn" onClick={testConnection}>Test connection</button>
          </div>
          <div className="frw"><span className="k">Last contact</span><span><span className="v">12 seconds ago</span><div className="vs">liveness beat every 60 seconds</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Sync Engine</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">State</span>
            <span>
              <span className="v" id="engState">{engState}</span>
              <div className={`vs${engSub.ok ? " okv" : ""}`} id="engStateSub">{engSub.text}</div>
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost sm" id="restartBtn" onClick={restartDaemon}>Restart</button>
              <button className="btn ghost sm" id="stopBtn" onClick={stopStart}>{daemonRunning ? "Stop" : "Start"}</button>
            </span>
          </div>
          <div className="frw"><span className="k">Uptime</span><span><span className="v">7h 41m</span><div className="vs">since Jul 20, 09:02</div></span></div>
          <div className="frw">
            <span className="k">Last pass</span>
            <span>
              <span className="v" id="lpV">{lpV}</span>
              <div className={`vs${lpVs.ok ? " okv" : ""}`} id="lpVs">{lpVs.text}</div>
            </span>
            <button className="btn ghost sm" id="tickBtn" onClick={tick}>Sync now</button>
          </div>
          <div className="frw"><span className="k">Queue</span><span><span className="v">2 sessions</span><div className="vs">312 KB waiting</div></span></div>
          <div className="frw"><span className="k">Backoff</span><span><span className="v">None</span></span></div>
          <div className="frw"><span className="k">Cadence</span><span><span className="v">Every 1.5 seconds</span><div className="vs">liveness beat every 60 seconds</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Local Folders</h2>
        <p style={{ fontSize: 15, color: "var(--text-muted)", maxWidth: 640, margin: "2px 0 0" }}>
          This device watches <b>3 locations</b> (Claude Code and Codex homes) holding <b id="devFolderCount">{plural(activeFolders.length, "folder")}</b>. The full folder-by-folder picture — what’s watched, where each folder goes, and why — lives in one place:
        </p>
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}><button className="btn ghost" onClick={() => goto("folders")}>Open Folders &amp; Destinations</button></div>
      </div>

      <div className="panel">
        <h2>Recent Issues</h2>
        <div className="rowlist">
          <div className="row"><span className="dot warn"></span><div className="who"><b>Liveness beat failed once</b><div className="sub">connection closed mid-request; recovered on the next beat</div></div><div><span className="pill warn">Recovered</span></div><div className="m">today, 16:12</div></div>
          <div className="row"><span className="dot"></span><div className="who"><b>No other issues in 7 days</b><div className="sub">uploads, storage checks and liveness all clean</div></div><div><span className="pill ok">All clear</span></div><div className="m">last 7 days</div></div>
        </div>
      </div>

      <div className="panel">
        <h2>Local Files</h2>
        <div className="facts">
          <div className="frw"><span className="k">State</span><span><span className="v mono">~/.let/hx/state.json</span><div className="vs">412 KB · per-file upload offsets</div></span></div>
          <div className="frw"><span className="k">Config</span><span><span className="v mono">~/.let/hx/config.json</span></span></div>
          <div className="frw"><span className="k">Logs</span><span><span className="v mono">~/.let/hx/stdout.log</span><div className="vs">see Client Logs for a live view</div></span></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={() => goto("logs")}>View client logs</button>
          <button className="btn ghost">Copy diagnostics</button>
        </div>
      </div>

      <div className="panel">
        <h2>Maintenance</h2>
        <div className="setrow">
          <div className="txt"><b>Sync Doctor</b><p>Explains anything that isn’t syncing — which sessions are held, at which HX Fortress, since when, what fixes it, and any gaps the sync bar can’t see.</p></div>
          <button className="btn ghost" id="doctorBtn" onClick={() => setDoctorOpen(true)}>Run Sync Doctor</button>
        </div>
        <div id="doctorOut" style={{ display: doctorOpen ? "" : "none", padding: "4px 0 14px" }}>
          <div className="rowlist">
            <div className="row"><span className="dot"></span><div className="who"><b>Sync</b><div className="sub">302 of 302 sessions · 45.1 MB — 100%</div></div><div><span className="pill ok">Healthy</span></div><div className="m">generated just now</div></div>
            <div className="row"><span className="dot"></span><div className="who"><b>Sync gaps</b><div className="sub">0 partial on server — no local files deleted, none aged out of the scan window</div></div><div><span className="pill ok">None</span></div><div className="m">—</div></div>
            <div className="row"><span className="dot warn"></span><div className="who"><b>9 sessions held at Nordbank | HX Fortress</b><div className="sub">fortress offline — first observed 16:02, retrying with backoff</div></div><div><span className="pill warn">Blocked</span></div><div className="m">next retry 17:20</div></div>
          </div>
          <div className="why-note" style={{ marginTop: 12 }}><b>Fix:</b> bring the Fortress online, or detach/move the repository to a project backed by a live Fortress. Nothing is lost — held sessions send automatically on reconnect.</div>
          <div className="why-act"><button className="btn ghost sm" id="retryBtn" onClick={() => flashResult(setRetryResult, "Blocked backoffs cleared (daemon paused and resumed around the edit) — Nordbank | HX Fortress is attempted immediately.")}>Retry blocked now</button><button className="btn ghost sm" onClick={() => goto("folders")}>Open Folders &amp; Destinations</button></div>
          <div className={`resultline${retryResult.on ? " on" : ""}`} id="retryResult">{retryResult.text}</div>
        </div>
        <div className="setrow" style={{ borderBottom: "none", paddingBottom: 6 }}>
          <div className="txt"><b>Back-fill task lists &amp; plans</b><p>Sessions synced before task tracking existed can upload their task lists and plans after the fact. Safe to run any time — already-uploaded items are skipped.</p></div>
          <button className="btn ghost" id="backfillBtn" onClick={() => flashResult(setBackfillResult, "Back-fill complete — 12 task sets · 3 plans uploaded, 0 failed.")}>Run back-fill</button>
        </div>
        <div className={`resultline${backfillResult.on ? " on" : ""}`} id="backfillResult">{backfillResult.text}</div>
        <details className="cliref">
          <summary>Prefer the command line?</summary>
          <p style={{ fontSize: 14.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>Everything in this app is also <code className="hx">hx</code> in a terminal:</p>
          <div className="clirow"><span className="c">hx status</span><span className="d">The Overview — account, gateway, daemon, connection quality, sync progress.</span></div>
          <div className="clirow"><span className="c">hx doctor sync</span><span className="d">“Run Sync Doctor” above — blocked sessions, gaps, and the fix (add <span className="mono">--json</span> for automation).</span></div>
          <div className="clirow"><span className="c">hx retry --blocked</span><span className="d">“Retry blocked now”, inside Sync Doctor.</span></div>
          <div className="clirow"><span className="c">hx logs</span><span className="d">Client Logs, as a live tail of the same files.</span></div>
          <div className="clirow"><span className="c">hx start · stop · restart</span><span className="d">The Sync Engine buttons above.</span></div>
          <div className="clirow"><span className="c">hx tick</span><span className="d">“Sync now” — one pass, then done.</span></div>
          <div className="clirow"><span className="c">hx backfill</span><span className="d">“Run back-fill” above.</span></div>
          <div className="clirow"><span className="c">hx update</span><span className="d">“Check for updates” then “Update to …”, in Identity — download, verify, install, restart.</span></div>
          <div className="clirow"><span className="c">hx connect · disconnect</span><span className="d">Signing this device in and out — Disconnect lives in Privacy Controls → Danger Zone.</span></div>
          <div className="clirow"><span className="c">hx uninstall</span><span className="d">Removing <code className="hx">hx</code> entirely — Danger Zone.</span></div>
          <div className="clirow"><span className="c">hx version</span><span className="d">The version row above — prints “hx version: 76.2.4”.</span></div>
          <div className="clirow"><span className="c">hx watch</span><span className="d">The sync daemon itself, run in the foreground — what this whole app is watching.</span></div>
          <div className="clirow"><span className="c">hx connect --local</span><span className="d">Developer tee: also mirror to a local dev gateway. Deliberately CLI-only.</span></div>
          <div className="clirow"><span className="c">hx ui</span><span className="d">Opens this app.</span></div>
        </details>
      </div>
    </section>
  );
}
