import { useState } from "react";
import { useApp } from "../store";
import { FORTRESSES, FORTRESS_BRAND, plural } from "../data";
import { CellA, CellB, CellC } from "../components/FolderCells";

export function FortressDetail() {
  const { view, goto, currentFortress, personalOn, fortressFolders } = useApp();
  const [result, setResult] = useState<{ text: string; on: boolean }>({ text: "", on: false });

  const ft = FORTRESSES.find((x) => x.id === currentFortress);
  const mine = ft ? fortressFolders(ft) : [];
  const n = mine.reduce((s, f) => s + f.sessions, 0);
  const off = !!ft?.personal && !personalOn;
  const org = ft ? ft.name.split(" |")[0] : "";

  const flashResult = (msg: string) => {
    setResult({ text: msg, on: true });
    setTimeout(() => setResult((s) => ({ ...s, on: false })), 4500);
  };

  return (
    <section className={`view${view === "fortress" ? " active" : ""}`} id="view-fortress">
      <div className="kicker"><a href="#" onClick={(e) => { e.preventDefault(); goto("overview"); }}>← Overview</a></div>
      <h1 id="ftTitle">{ft ? ft.name : "Fortress"}</h1>
      <p className="lede" id="ftLede">{ft
        ? (ft.personal
          ? `let.ai runs this ${FORTRESS_BRAND} as my private space. Personal sessions — folders without a company project — go to this ${FORTRESS_BRAND}, and only I can ever see them.`
          : `${org} runs this ${FORTRESS_BRAND} on its own servers. All work sessions in ${org} git repositories go to this ${FORTRESS_BRAND} — session content never rests on let.ai’s.`)
        : ""}</p>
      <div className="panel">
        <h2>Folders Stored Here</h2>
        <div id="ftFolders">
          {mine.length ? (
            <div className="ftable">
              {mine.map((f) => (
                <div key={f.id} className="prevrow" onClick={() => goto("folders")}>
                  <CellA f={f} isExcluded={false} />
                  <CellB f={f} isExcluded={false} />
                  <CellC f={f} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ftable"><div className="empty">No folders route here right now.</div></div>
          )}
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>Connection</h2>
          <div className="facts" id="ftConn">
            {ft && (
              <>
                <div className="frw"><span className="k">Status</span><span><span className="v">{off ? "Off — personal sync is disabled" : ft.pill[1]}</span><div className="vs">last contact {ft.last}</div></span></div>
                <div className="frw"><span className="k">Link quality</span><span><span className="v">{ft.quality}</span></span></div>
              </>
            )}
          </div>
        </div>
        <div className="panel">
          <h2>Storage</h2>
          <div className="facts" id="ftStore">
            {ft && (
              <>
                <div className="frw"><span className="k">Sessions</span><span><span className="v">{plural(n, "session")}</span><div className="vs">{ft.bytes} across {plural(mine.length, "folder")}</div></span></div>
                <div className="frw"><span className="k">Integrity</span><span><span className="v">{off ? "—" : "Verified"}</span><div className="vs">{ft.offsets}</div></span></div>
                <div className="frw"><span className="k">Last sent</span><span><span className="v">{off ? "—" : ft.last}</span></span></div>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
            <button className="btn ghost sm" id="ftCheckBtn" onClick={() => flashResult("Storage check passed — a 2 KB test write landed and was read back in 240 ms.")}>Check storage now</button>
            <button className="btn ghost sm" id="ftSyncBtn" onClick={() => flashResult("Pass complete — this fortress is fully current.")}>Sync now</button>
          </div>
          <div className={`resultline${result.on ? " on" : ""}`} id="ftResult">{result.text}</div>
        </div>
      </div>
    </section>
  );
}
