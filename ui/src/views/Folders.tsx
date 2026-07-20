import { useState, type ReactNode } from "react";
import { useApp, type GroupBy } from "../store";
import { FOLDERS, FORTRESSES, TOOL_NOTE, TOOL_ORDER, destLabel, plural, type Folder } from "../data";
import { GPill } from "../components/GPill";
import { CellA, CellB, CellC } from "../components/FolderCells";
import { BranchIc, CloudIc, CompanyIc, FortressIc, ProjectIc, SearchIc } from "../icons";

const GLBL: Record<GroupBy, string> = { tool: "Tool", dir: "Directory", dest: "Cloud Destination", person: "Person" };

function FolderWhy({ f }: { f: Folder }) {
  const { excluded, personalOn, includeFolder, excludeFolder, applyPersonal } = useApp();
  if (excluded.has(f.id)) {
    return (
      <>
        <div className="why-note"><b>Excluded.</b> Nothing from this folder leaves this machine — it isn’t uploaded to any company fortress or to my private space.</div>
        <div className="why-act"><button className="btn ghost sm" onClick={() => includeFolder(f.id)}>Include again</button></div>
      </>
    );
  }
  if (f.personal && !personalOn) {
    return (
      <>
        <div className="why-note"><b>Personal sync is off</b>, so this folder stays on this machine. Turn personal sync back on to resume uploading it to my private space.</div>
        <div className="why-act"><button className="btn ghost sm" onClick={() => applyPersonal(true)}>Turn personal sync on</button></div>
      </>
    );
  }
  let chain: ReactNode;
  let notes: ReactNode;
  if (f.repo && f.project) {
    chain = (
      <>
        <span className="step"><BranchIc /> {f.repo}</span><span className="arr">→</span>
        <span className="step"><ProjectIc /> {f.project}</span><span className="arr">→</span>
        <span className="step"><CompanyIc /> {f.company}</span><span className="arr">→</span>
        <span className="step hl"><FortressIc /> {destLabel(f.dest)}</span>
      </>
    );
    notes = (
      <>
        <div className="why-note">This folder’s git repo is attached to the <b>{f.project}</b> project in <b>{f.company}</b>, which stores all its session data on its own servers — <b>never on let.ai’s</b>. Sessions here appear in My Sessions.</div>
        {f.shared ? (
          <>
            <div className="why-note"><b>Who can see it:</b> the <b>Payments</b> team has access to the {f.project} project, and I’ve opted into team sharing — these members can currently open my {f.project} sessions:</div>
            <div className="people">
              <span className="pchip"><span className="pa" style={{ background: "#5b5bd6" }}>JO</span> Me</span>
              <span className="pchip"><span className="pa" style={{ background: "#17835b" }}>MN</span> Marta Nilsson</span>
              <span className="pchip"><span className="pa" style={{ background: "#b25e09" }}>PS</span> Priya Shah</span>
              <span className="pchip"><span className="pa" style={{ background: "#8a5bd6" }}>TB</span> Tomas Berg</span>
              <span className="pmore">· 2 team members haven’t opted in and see nothing</span>
            </div>
          </>
        ) : (
          <div className="why-note"><b>Who can see it:</b> only me.</div>
        )}
      </>
    );
  } else if (f.repo && f.noProject) {
    chain = (
      <>
        <span className="step"><BranchIc /> {f.repo}</span><span className="arr">→</span>
        <span className="step dashed">no matching project in my companies</span><span className="arr">→</span>
        <span className="step hl"><CloudIc /> treated as personal</span>
      </>
    );
    notes = <div className="why-note">This folder has a git repo, but no project in orange-corp or nordbank has it attached — so it’s <b>personal</b>: my private let.ai space, visible only to me. <b>If this is company code</b>, an admin can attach <span className="mono">{f.repo}</span> to a project and future sessions move to that company’s fortress.</div>;
  } else {
    chain = (
      <>
        <span className="step dashed">no git repo</span><span className="arr">→</span>
        <span className="step hl"><CloudIc /> {destLabel(f.dest)} — personal</span>
      </>
    );
    notes = <div className="why-note">No repo, no company link — private to me.</div>;
  }
  return (
    <>
      <div className="chain">{chain}</div>
      {notes}
      <div className="why-act"><button className="btn ghost sm" onClick={() => excludeFolder(f.id)}>Exclude this folder</button></div>
    </>
  );
}

export function FolderRow({ f }: { f: Folder }) {
  const { excluded, personalOn, openRows, toggleRow, openFortress } = useApp();
  const isExcluded = excluded.has(f.id);
  const dim = isExcluded || (f.personal && !personalOn);
  const open = openRows.has(f.id);
  return (
    <div className={`frow${dim ? " dim" : ""}${open ? " open" : ""}`} data-id={f.id}>
      <div className="line" onClick={() => toggleRow(f.id)}>
        <CellA f={f} isExcluded={isExcluded} />
        <CellB f={f} isExcluded={isExcluded} destAction={openFortress} />
        <CellC f={f} />
        <div className="chev"></div>
      </div>
      <div className="fwhy"><FolderWhy f={f} /></div>
    </div>
  );
}

interface Group { title: string; note: string; items: Folder[]; }

function groupsFor(list: Folder[], groupBy: GroupBy, excluded: Set<string>): Group[] {
  if (groupBy === "tool") {
    return TOOL_ORDER.map((t) => ({
      title: t,
      note: list.some((f) => f.tool === t) ? (TOOL_NOTE[t] ? `· ${TOOL_NOTE[t]}` : "") : "· nothing found on this device",
      items: list.filter((f) => f.tool === t),
    }));
  }
  const keyFn = groupBy === "dir" ? (f: Folder) => (f.path.startsWith("/workspace") ? "/workspace" : "~ (home)")
    : groupBy === "dest" ? (f: Folder) => (excluded.has(f.id) ? "Excluded" : f.dest)
    : (f: Folder) => (excluded.has(f.id) ? "Excluded" : f.vis);
  const m = new Map<string, Folder[]>();
  for (const f of list) {
    const k = keyFn(f);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  return [...m.entries()].map(([title, items]) => ({ title, note: "", items }));
}

export function Folders() {
  const { view, personalOn, applyPersonal, groupBy, setGroupBy, query, setQuery, excluded, openFortress } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  const q = query.trim().toLowerCase();
  const list = FOLDERS.filter((f) => !q ||
    [f.path, f.repo, f.project, f.company, f.dest, f.vis, f.tool,
      f.shared ? "marta nilsson priya shah tomas berg payments" : ""]
      .filter(Boolean).join(" ").toLowerCase().includes(q));
  const groups = groupsFor(list, groupBy, excluded).filter((g) => g.items.length || groupBy === "tool");

  // Destination group headers are the fortress itself — clickable, pipe-branded.
  const groupTitle = (title: string) => {
    const ft = FORTRESSES.find((x) => x.destMatch === title);
    return ft
      ? <b className="grplink" data-fortress={ft.id} onClick={() => openFortress(ft.id)}>{destLabel(title)}</b>
      : <b>{title}</b>;
  };

  return (
    <section className={`view${view === "folders" ? " active" : ""}`} id="view-folders">
      <div className="kicker">This device</div>
      <h1>Folders &amp; Destinations</h1>
      <p className="lede">Every folder where an agentic tool keeps sessions, and the exact place each one is stored. Open a row to see <i>why</i> it goes where it goes, and who can see it.</p>

      {!personalOn && (
        <div className="banner info" id="personalOffBanner" style={{ display: "flex" }}>
          <span className="badge">i</span>
          <span><b>Personal session sync is off.</b> Dimmed folders stay on this machine only. Company folders continue to sync.</span>
          <button className="btn" id="reenableBtn" onClick={() => applyPersonal(true)}>Turn back on</button>
        </div>
      )}

      <div className="toolbar">
        <GPill id="groupPill" label="Group by" value={GLBL[groupBy]} valueId="groupVal" menuId="groupMenu" open={menuOpen} setOpen={setMenuOpen}>
          {(Object.keys(GLBL) as GroupBy[]).map((g) => (
            <button key={g} className={groupBy === g ? "sel" : undefined} onClick={() => { setGroupBy(g); setMenuOpen(false); }}>{GLBL[g]}</button>
          ))}
        </GPill>
        <div className="search">
          <SearchIc />
          <input id="folderSearch" placeholder="Search folders, repos, projects, destinations…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div id="folderList">
        {!list.length ? (
          <div className="ftable"><div className="empty">Nothing matches “{query}”.</div></div>
        ) : groups.map((g) => (
          <div className="toolgrp" key={g.title}>
            <div className="toolhdr">{groupTitle(g.title)}<span className="cnt">{g.items.length ? "· " + plural(g.items.reduce((n, f) => n + f.sessions, 0), "session") + " " : ""}{g.note}</span></div>
            {g.items.length > 0 && <div className="ftable">{g.items.map((f) => <FolderRow key={f.id} f={f} />)}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
