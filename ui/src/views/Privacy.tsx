import { useRef, useState } from "react";
import { useApp } from "../store";
import { GPill } from "../components/GPill";
import { FolderIc } from "../icons";

const PAUSE_OPTIONS: [string, string][] = [
  ["15", "Pause for 15 minutes"],
  ["60", "Pause for 1 hour"],
  ["240", "Pause for 4 hours"],
  ["tomorrow", "Pause until tomorrow morning"],
  ["forever", "Pause until I resume it"],
];

export function Privacy() {
  const {
    view, goto, personalOn, applyPersonal, setGroupBy,
    manualExclusions, addRule, removeRule,
    pause, pickPause, resumeAll, setInspOpen,
  } = useApp();
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [ruleVal, setRuleVal] = useState("");
  const ruleRef = useRef<HTMLInputElement>(null);

  const doAddRule = () => {
    const v = ruleVal.trim();
    if (v && !manualExclusions.includes(v)) {
      addRule(v);
      setRuleVal("");
      ruleRef.current?.focus();
    }
  };

  return (
    <section className={`view${view === "privacy" ? " active" : ""}`} id="view-privacy">
      <div className="kicker">Settings</div>
      <h1>Privacy Controls</h1>
      <p className="lede">Everything <code className="hx">hx</code> does is visible and reversible from here. Settings apply to this device.</p>

      <div className="panel">
        <h2>Uploads</h2>
        <div className="setrow">
          <label className="switch"><input type="checkbox" className="personal-master" checked={personalOn} onChange={(e) => applyPersonal(e.target.checked)} /><span className="track"></span></label>
          <div className="txt"><b>Sync personal sessions to my private let.ai space</b><p>Folders without a company project link. Only I can ever see them. Off = they never leave this machine.</p></div>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Pause all syncing</b>
            <p>Temporarily stop every upload — company and personal. Sessions queue safely on this machine and catch up on resume.</p>
            <div className={`pausestate${pause ? " on" : ""}`} id="pauseState">{pause?.msg}</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn ghost" id="resumeBtn" style={{ display: pause ? "" : "none" }} onClick={resumeAll}>Resume now</button>
            <GPill id="pausePill" value={pause ? "Paused" : "Not paused"} valueId="pauseVal" menuId="pauseMenu" open={pauseMenuOpen} setOpen={setPauseMenuOpen}>
              {PAUSE_OPTIONS.map(([p, label]) => (
                <button key={p} onClick={() => { pickPause(p); setPauseMenuOpen(false); }}>{label}</button>
              ))}
            </GPill>
          </div>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Excluded folders</b>
            <p>Never uploaded, regardless of any other setting. Each folder is included or excluded on its own row in Folders &amp; Destinations.</p>
          </div>
          <button className="btn ghost" id="reviewExclBtn" onClick={() => { setGroupBy("dest"); goto("folders"); }}>→ Folders &amp; Destinations</button>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Future Folders</b>
            <p>Future Folders cover paths <code className="hx">hx</code> hasn’t detected sessions in yet — the moment one appears, the session will be marked as excluded. Anything already uploaded stays where it is; to remove uploaded data, use “Delete my synced sessions” below.</p>
            <div className="rulebox" id="pathRules">
              {manualExclusions.length ? manualExclusions.map((p) => (
                <div className="rulerow" key={p}><span className="ico"><FolderIc /></span><span className="p">{p}</span><button className="btn ghost sm" onClick={() => removeRule(p)}>Remove</button></div>
              )) : (
                <div className="rulerow"><span className="ico"><FolderIc /></span><span className="none">No future folders yet — add a path below.</span></div>
              )}
              <div className="ruleadd">
                <span className="ico"><FolderIc /></span>
                <input id="ruleInput" ref={ruleRef} placeholder="~/folder-that-does-not-exist-yet" value={ruleVal} onChange={(e) => setRuleVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAddRule(); }} />
                <button className="btn sm" id="ruleAddBtn" onClick={doAddRule}>Add</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>What Leaves This Machine</h2>
        <div className="setrow">
          <div className="txt"><b>Preview outgoing data</b><p>Open a preview of the transcript text queued for upload, before it’s sent.</p></div>
          <button className="btn ghost" id="inspectorBtn" onClick={() => setInspOpen(true)}>Open inspector</button>
        </div>
        <div className="setrow">
          <label className="switch"><input type="checkbox" defaultChecked /><span className="track"></span></label>
          <div className="txt"><b>Don’t send sessions that look like they contain secrets or related confidential information</b><p>Transcripts matching common key, token and credential patterns stay on this machine, flagged for my review.</p></div>
        </div>
      </div>

      <div className="panel danger">
        <h2>Danger Zone</h2>
        <div className="setrow">
          <div className="txt"><b>Disconnect this device</b><p>Signs this device out and stops all syncing. Nothing already uploaded is deleted.</p></div>
          <button className="btn danger">Disconnect</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Delete my synced sessions</b><p>Delete all sessions from my let.ai space. Company HX fortresses follow each company’s retention policy.</p></div>
          <button className="btn danger">Delete</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Uninstall <code className="hx">hx</code> from this device</b><p>Stops the daemon and removes the <code className="hx">hx</code> program. I choose whether local state and logs are removed too; nothing already uploaded is affected.</p></div>
          <button className="btn danger">Uninstall</button>
        </div>
      </div>
    </section>
  );
}
