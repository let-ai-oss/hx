import { FORTRESSES, destLabel, plural, type Folder } from "../data";
import { BranchIc, CloudIc, FolderIc, FortressIc, PersonIc, SlashIc, TeamIc } from "../icons";

// Strict two-line cells — every cell shares the same line grid so icons,
// destinations, and counts all read as vertical columns.

export function CellA({ f, isExcluded }: { f: Folder; isExcluded: boolean }) {
  const np = f.noProject && !isExcluded ? <> <span className="pill warn mini">no project</span></> : null;
  return (
    <div className="cell cellA">
      <div className="cl l1"><span className="ico"><FolderIc /></span><span className="tx path">{f.path}</span></div>
      <div className="cl l2">
        {f.repo
          ? <><span className="ico"><BranchIc /></span><span className="tx repo">{f.repo}</span>{np}<span className="tx">· {f.tool}</span></>
          : <><span className="ico" style={{ visibility: "hidden" }}><BranchIc /></span><span className="tx" style={{ fontStyle: "italic" }}>no git repo</span><span className="tx">· {f.tool}</span></>}
      </div>
    </div>
  );
}

export function CellB({ f, isExcluded, destAction }: { f: Folder; isExcluded: boolean; destAction?: (ftId: string) => void }) {
  if (isExcluded) {
    return (
      <div className="cell cellB">
        <div className="cl l1 exc"><span className="ico"><SlashIc /></span><span className="tx">Excluded</span></div>
        <div className="cl l2"><span className="ico" style={{ visibility: "hidden" }}><PersonIc /></span><span className="tx">Never uploaded</span></div>
      </div>
    );
  }
  const kind = f.destKind === "fortress" ? "fortress" : "cloudy";
  const ft = f.destKind === "fortress" ? FORTRESSES.find((x) => x.destMatch === f.dest) : undefined;
  return (
    <div className="cell cellB">
      <div className={`cl l1 ${kind}`}>
        <span className="ico">{f.destKind === "fortress" ? <FortressIc /> : <CloudIc />}</span>
        {ft
          ? <span className="tx destlink" data-fortress={ft.id} onClick={destAction ? (e) => { e.stopPropagation(); destAction(ft.id); } : undefined}>{destLabel(f.dest)}</span>
          : <span className="tx">{destLabel(f.dest)}</span>}
      </div>
      <div className="cl l2"><span className="ico">{f.visKind === "team" ? <TeamIc /> : <PersonIc />}</span><span className="tx">{f.vis}</span></div>
    </div>
  );
}

export function CellC({ f }: { f: Folder }) {
  return <div className="cell cellC">{plural(f.sessions, "session")}</div>;
}
