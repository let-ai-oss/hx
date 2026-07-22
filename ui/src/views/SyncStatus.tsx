import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtClock, fmtRelative } from "../api";

export function SyncStatus() {
  const { view, goto, snap, destinations } = useApp();

  const sync = snap?.sync;
  const doctor = snap?.doctor;
  const waiting = (sync?.behind ?? 0) + (sync?.waiting ?? 0);
  const recent = snap?.recent ?? [];
  const last = recent[0];
  const destLabel = (key: string) => destinations.find((d) => d.key === key)?.label ?? key;

  return (
    <section className={`view${view === "activity" ? " active" : ""}`} id="view-activity">
      <div className="kicker">This device</div>
      <h1>Sync Status</h1>
      <p className="lede">What <code className="hx">hx</code> is syncing right now, what’s queued, and what this device has been sending.</p>

      <div className="stats">
        <div className="stat"><span className="lbl">On disk</span><div className="big">{sync?.total ?? "…"}</div><div className="sub">{sync ? `sessions · ${fmtBytes(sync.totalBytes)}` : ""}</div></div>
        <div className="stat"><span className="lbl">Mirrored</span><div className="big">{doctor ? `${doctor.sync.percent}%` : "…"}</div><div className="sub">{doctor ? `${doctor.sync.done} of ${doctor.sync.total} sessions` : ""}</div></div>
        <div className="stat"><span className="lbl">Waiting</span><div className="big">{sync ? waiting : "…"}</div><div className="sub">{waiting > 0 ? "uploads on the next pass" : "nothing queued"}</div></div>
        <div className="stat"><span className="lbl">Last sent</span><div className="big">{fmtRelative(sync?.lastUploadAtMs ?? 0).replace(" ago", "")}</div><div className="sub">{last ? `ago, to ${last.dests.map(destLabel).join(" · ")}` : "ago"}</div></div>
      </div>

      {doctor && doctor.blockers.length > 0 && (
        <div className="panel">
          <h2>Held Right Now</h2>
          <div className="h2sub">Destinations that can’t take uploads at the moment — nothing is lost; queued sessions send on reconnect.</div>
          <div className="rowlist">
            {doctor.blockers.map((b, i) => (
              <div className="row" key={i}>
                <span className="dot warn"></span>
                <div className="who"><b>{b.orgName ?? "Organization vault"}</b><div className="sub">{b.reason === "vault_offline" ? "Session Vault offline — sessions held safely until it reconnects" : "store unreachable — retrying with backoff"}</div></div>
                <div><span className="pill warn">Held</span></div>
                <div className="m">{plural(b.sessions, "session")}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Recently Synced</h2>
        <div className="h2sub">Newest first — the most recent sessions this device uploaded.</div>
        <div className="rowlist" id="syncNow">
          {recent.length === 0 && (
            <div className="row"><div className="who"><b>Nothing uploaded yet</b><div className="sub">sessions appear here as the mirror sends them</div></div></div>
          )}
          {recent.map((r) => (
            <div className="row" key={`${r.atMs}-${r.title}`}>
              <span className="dot"></span>
              <div className="who"><span className="t">{fmtClock(r.atMs)}</span><b>{r.title}</b><div className="sub">{r.folder}</div></div>
              <div>{r.dests.map((d) => (
                <span key={d} className={`pill ${d === "letai" ? "cloud" : "fortress"} mini`}>{destLabel(d)}</span>
              ))}</div>
              <div className="m">{fmtBytes(r.sizeBytes)}</div>
            </div>
          ))}
          <div style={{ padding: "12px 4px 4px", fontSize: 14, color: "var(--text-subtle)" }}>The complete record lives in <a href="#" onClick={(e) => { e.preventDefault(); goto("logs"); }}>Client Logs</a>.</div>
        </div>
      </div>
    </section>
  );
}
