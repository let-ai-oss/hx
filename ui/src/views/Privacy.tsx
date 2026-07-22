import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes } from "../api";
import { CloudIc, FortressIc } from "../icons";

export function Privacy() {
  const { view, goto, openInspector, destinations, activeFolders } = useApp();

  const personalFolders = activeFolders.filter((f) => f.dests.length > 0 && f.dests.every((d) => d === "letai"));

  return (
    <section className={`view${view === "privacy" ? " active" : ""}`} id="view-privacy">
      <div className="kicker">Settings</div>
      <h1>Privacy Controls</h1>
      <p className="lede">Everything <code className="hx">hx</code> does is visible from here — what uploads, where it rests, and who can ever see it.</p>

      <div className="panel">
        <h2>What Leaves This Machine</h2>
        <div className="setrow">
          <div className="txt"><b>Preview outgoing data</b><p>Open a preview of the transcript text this device uploads — the exact same bytes, nothing more.</p></div>
          <button className="btn ghost" id="inspectorBtn" onClick={() => openInspector()}>Open inspector</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Where sessions rest</b><p>Sessions in folders whose git repo belongs to an organization workspace route to that organization. Everything else uploads as <b>personal</b> — visible only to you.</p>
            <div className="rulebox" style={{ marginTop: 10 }}>
              {destinations.length === 0 ? (
                <div className="rulerow"><span className="none">Nothing uploaded yet — destinations appear after the first sync pass.</span></div>
              ) : destinations.map((d) => (
                <div className="rulerow" key={d.key}>
                  <span className="ico">{d.personal ? <CloudIc /> : <FortressIc />}</span>
                  <span className="p">{d.label}</span>
                  <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>{plural(d.sessions, "session")} · {fmtBytes(d.bytes)}{d.personal ? " · only you" : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="setrow">
          <div className="txt"><b>Personal folders on this device</b><p>{personalFolders.length > 0
            ? `${plural(personalFolders.length, "folder uploads", "folders upload")} as personal right now — no organization workspace claims ${personalFolders.length === 1 ? "its repo" : "their repos"}, or there is no git repo at all.`
            : "Every watched folder currently routes to an organization workspace."}</p></div>
          <button className="btn ghost" onClick={() => goto("folders")}>→ Folders &amp; Destinations</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Logs stay local</b><p>The daemon’s own logs never upload anywhere — read them any time in Client Logs, or on disk under <span className="mono">~/.let/hx/</span>.</p></div>
          <button className="btn ghost" onClick={() => goto("logs")}>→ Client Logs</button>
        </div>
      </div>
    </section>
  );
}
