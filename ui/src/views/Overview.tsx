import { useApp } from "../store";
import { FORTRESSES, plural } from "../data";
import { CellA, CellB, CellC } from "../components/FolderCells";
import { CliToolIc, DesktopToolIc, FortressIc } from "../icons";

export function Overview() {
  const {
    view, goto, openFortress, excluded, personalOn, deviceName,
    activeFolders, fortressFolders, reviewUnlinked, jumpFortressList, jumpDoctor, setInspOpen,
  } = useApp();

  const act = activeFolders;
  const sessionSum = act.reduce((n, f) => n + f.sessions, 0);
  const top = [...act].sort((a, b) => b.sessions - a.sessions).slice(0, 4);

  return (
    <section className={`view${view === "overview" ? " active" : ""}`} id="view-overview">
      <div className="kicker">This device</div>
      <h1>My sessions, and where they go</h1>
      <p className="lede"><code className="hx">hx</code> mirrors the agentic coding sessions on this machine so they’re never lost. Here’s what’s picked up, where every session is stored, and who can see it.</p>

      <div className="stats">
        <div className="stat">
          <span className="lbl">Folders watched</span>
          <div className="big statlink" onClick={() => goto("folders")}><span id="ovFolders">{act.length}</span><div className="pop">See which folders →</div></div>
          <div className="sub">across <span className="dashy">3 tools<div className="pop">
            <b>Tools detected on this device</b>
            <div className="poprow" style={{ marginTop: 8 }}><span className="ico"><CliToolIc /></span><span className="grow">Claude Code CLI</span><span className="st on">5 folders</span></div>
            <div className="poprow"><span className="ico"><DesktopToolIc /></span><span className="grow">Claude Code Desktop</span><span className="st on">2 folders</span></div>
            <div className="poprow"><span className="ico"><CliToolIc /></span><span className="grow">Codex CLI</span><span className="st on">2 folders</span></div>
            <div className="poprow"><span className="ico"><DesktopToolIc /></span><span className="grow">Codex Desktop</span><span className="st offy">none found</span></div>
          </div></span></div>
        </div>
        <div className="stat">
          <span className="lbl">Sessions on disk</span>
          <div className="big statlink" id="ovSessionsLink" onClick={() => setInspOpen(true)}><span id="ovSessions">{sessionSum}</span><div className="pop">Preview what leaves this machine →</div></div>
          <div className="sub">all safely mirrored</div>
        </div>
        <div className="stat">
          <span className="lbl">Destinations</span>
          <div className="big statlink" id="ovDestsBig" onClick={jumpFortressList}>3<div className="pop">Jump to the fortress list →</div></div>
          <div className="sub"><span className="dashy">2 company<div className="pop">
            <b>Company HX Fortresses</b>
            <div className="poprow" style={{ marginTop: 8 }}><span className="ico"><FortressIc /></span><span className="grow">Orange Corp | HX Fortress</span><span className="st on">Connected</span></div>
            <div className="poprow"><span className="ico"><FortressIc /></span><span className="grow">Nordbank | HX Fortress</span><span className="st warny">Retrying</span></div>
            <div style={{ marginTop: 6 }}>Session content goes to servers each company runs itself — never let.ai’s.</div>
          </div></span> · <span className="dashy">1 personal<div className="pop">
            <b>let.ai | HX Fortress</b>
            <div style={{ marginTop: 6 }}>My private space, operated by let.ai. Only I can ever see it — no company, no teammate. It exists so my own My Sessions history is complete.</div>
          </div></span></div>
        </div>
        <div className="stat">
          <span className="lbl">Caught up</span>
          <div className="big"><span className="hovinfo" id="yesLink" onClick={jumpDoctor}>Yes<div className="pop">
            <b>Everything on this machine is mirrored.</b>
            <div style={{ marginTop: 6 }}>All 302 sessions are safely stored at their destinations — nothing to do. If this ever says <b>No</b>, this card explains exactly what’s blocked and why, and Sync Doctor (Device Detail → Maintenance) walks through the fix.</div>
          </div></span></div>
          <div className="sub"><span className="dashy">2 sending now<div className="pop">
            <b>In flight right now</b>
            <div className="poprow" style={{ marginTop: 8 }}><span className="grow">“Fix S3 routing gates”</span><span className="st on">184 KB · 60%</span></div>
            <div className="poprow"><span className="grow">“Refactor probe grading”</span><span className="st offy">queued · 61 KB</span></div>
          </div></span></div>
        </div>
      </div>

      {!excluded.has("rind") && (
        <div className="banner warn" id="unlinkedBanner">
          <span className="badge">!</span>
          <span className="btxt"><b>1 folder looks like company code but isn’t linked to a project.</b> <span className="mono">/workspace/rind</span> has a git repo no project claims, so it’s treated as personal. If that’s wrong, an admin can attach the repo to a project.</span>
          <button className="btn" id="reviewBtn" onClick={reviewUnlinked}>Review</button>
        </div>
      )}

      <div className="sechead" id="fortressHead">Connected To: HX Fortresses</div>
      <div className="panel" id="fortressPanel" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <div className="rowlist" id="fortressList">
          {FORTRESSES.map((ft) => {
            const mine = fortressFolders(ft);
            const n = mine.reduce((s, f) => s + f.sessions, 0);
            const off = !!ft.personal && !personalOn;
            const pill = off ? ["off", "Off"] : ft.pill;
            return (
              <div key={ft.id} className="row fortrow" data-fortress={ft.id} onClick={() => openFortress(ft.id)}>
                <span className={`dot${pill[0] === "warn" ? " warn" : ""}`} style={off ? { background: "var(--border-strong)" } : undefined}></span>
                <div className="who"><b>{ft.name}</b><div className="sub">{ft.sub}</div></div>
                <div><span className={`pill ${pill[0]}`}>{pill[1]}</span></div>
                <div className="fortmeta">{off ? <div>not syncing</div> : <><div>{plural(n, "session")} · {ft.bytes}</div><div>last sent {ft.last}</div></>}</div>
                <div className="chev"></div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="sechead">Most Active Folders <a href="#" id="allFoldersLink" onClick={(e) => { e.preventDefault(); goto("folders"); }}>All {act.length} folders →</a></div>
      <div className="ftable" id="ovPreview" style={{ marginBottom: 20 }}>
        {top.map((f) => (
          <div key={f.id} className="prevrow" onClick={() => goto("folders")}>
            <CellA f={f} isExcluded={false} />
            <CellB f={f} isExcluded={false} destAction={openFortress} />
            <CellC f={f} />
          </div>
        ))}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>This Device</h2>
          <div className="facts">
            <div className="frw"><span className="k">Device</span><span><span className="v devname">{deviceName}</span><div className="vs">Linux arm64 · container</div></span></div>
            <div className="frw"><span className="k"><code className="hx">hx</code> version</span><span><span className="v mono">76.2.4</span><div className="vs">up to date · stable channel</div></span></div>
            <div className="frw"><span className="k">Signed in as</span><span><span className="v">Johnny Orange</span></span></div>
            <div className="frw"><span className="k">My companies</span><span><span className="v">orange-corp · nordbank</span></span></div>
            <div className="frw"><span className="k">Watching since</span><span><span className="v">Jul 18, 09:14</span></span></div>
          </div>
        </div>
        <div className="panel">
          <h2>Right Now</h2>
          <div className="facts">
            <div className="frw"><span className="k">Connection</span><span><span className="v">Excellent</span><div className="vs">26 ms · 13.3 MB/s</div></span></div>
            <div className="frw"><span className="k">Waiting to send</span><span><span className="v">2 sessions</span><div className="vs">sending now</div></span></div>
            <div className="frw"><span className="k">Sent today</span><span><span className="v">14 sessions · 9.9 MB</span></span></div>
            <div className="frw"><span className="k">Personal sessions</span><span><span className="v" id="ovPersonalState">{personalOn ? "Syncing to my private space" : "Staying on this machine"}</span></span></div>
            <div className="frw"><span className="k">What’s uploaded</span><span><span className="v"><a href="#" onClick={(e) => { e.preventDefault(); goto("privacy"); }}>See &amp; control what leaves this machine</a></span></span></div>
          </div>
        </div>
      </div>
    </section>
  );
}
