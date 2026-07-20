import { useRef, useState } from "react";
import { useApp } from "../store";
import { EARLIER, FOLDERS, HOURS, MAX_MB, SENT, destLabel, plural, type SentRow } from "../data";

function Chart() {
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  return (
    <div className="chart">
      <div className="yaxis"><span>2 MB</span><span>1 MB</span><span>0</span></div>
      <div className="plot">
        <div className="gridl" style={{ top: 0 }}></div>
        <div className="gridl" style={{ top: "50%" }}></div>
        <div
          className="bars" id="bars" ref={barsRef}
          onMouseOver={(e) => {
            const t = e.target as HTMLElement;
            if (t.tagName === "I" && t.dataset.tip) {
              const r = t.getBoundingClientRect();
              const pr = barsRef.current!.getBoundingClientRect();
              setTip({ text: t.dataset.tip, left: r.left - pr.left + r.width / 2 });
            }
          }}
          onMouseLeave={() => setTip(null)}
        >
          <div className="tip" id="barTip" style={tip ? { display: "block", left: tip.left } : undefined}>{tip?.text}</div>
          {HOURS.map(([h, mb, sess]) => (
            <i
              key={h}
              className={mb >= 1 ? "hot" : undefined}
              style={{ height: Math.max(3, (mb / MAX_MB) * 100) + "%" }}
              data-tip={`${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00 · ${mb.toFixed(1)} MB · ${plural(sess, "session")}`}
            />
          ))}
        </div>
        <div className="axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span></div>
      </div>
    </div>
  );
}

function SentRowEl({ row }: { row: SentRow }) {
  const [t, pre, bold, kind, dest, size] = row;
  return (
    <div className="row">
      <span className="dot"></span>
      <div className="who"><span className="t">{t}</span>{pre}{bold ? <b>{bold}</b> : null}</div>
      <div><span className={`pill ${kind} mini`}>{destLabel(dest)}</span></div>
      <div className="m">{size}</div>
    </div>
  );
}

export function SyncStatus() {
  const { view, goto, pause, resumeAll, recentlyIncluded } = useApp();
  const [showEarlier, setShowEarlier] = useState(false);

  return (
    <section className={`view${view === "activity" ? " active" : ""}`} id="view-activity">
      <div className="kicker">This device</div>
      <h1>Sync Status</h1>
      <p className="lede">What <code className="hx">hx</code> is syncing right now, what’s queued, and what this device has been sending.</p>

      {pause && (
        <div className="banner warn" id="pauseBanner" style={{ display: "flex" }}>
          <span className="badge">II</span>
          <span className="btxt" id="pauseBannerText"><b>Syncing is paused.</b> {pause.msg.replace("Paused — ", "It ")}{pause.forever ? "" : "."} Sessions keep queueing safely on this machine.</span>
          <button className="btn" id="pauseBannerResume" onClick={resumeAll}>Resume now</button>
        </div>
      )}

      <div className="stats">
        <div className="stat"><span className="lbl">Sent today</span><div className="big">14</div><div className="sub">sessions · 9.9 MB</div></div>
        <div className="stat"><span className="lbl">Waiting</span><div className="big">2</div><div className="sub">sessions · 312 KB, sending now</div></div>
        <div className="stat"><span className="lbl">Uploads today</span><div className="big">41</div><div className="sub">average 247 KB each</div></div>
        <div className="stat"><span className="lbl">Last sent</span><div className="big">12s</div><div className="sub">ago, to Orange Corp fortress</div></div>
      </div>

      <div className="panel">
        <h2>Now &amp; Recent</h2>
        <div className="h2sub">One stream, newest first — what’s in flight right now, then what most recently left.</div>
        <div className="rowlist" id="syncNow">
          {recentlyIncluded.map((id) => {
            const f = FOLDERS.find((x) => x.id === id)!;
            return (
              <div className="row" key={`bf-${id}`}>
                <span className="dot warn"></span>
                <div className="who"><b className="mono" style={{ fontWeight: 600 }}>{f.path}</b><div className="sub">included again — re-uploading its history to {destLabel(f.dest)}</div></div>
                <div><span className="pill fortress">Back-filling</span></div>
                <div className="m">{plural(f.sessions, "session")} queued</div>
              </div>
            );
          })}
          <div className="row">
            <span className="dot"></span>
            <div className="who"><b>“Fix S3 routing gates”</b><div className="sub">uploading to {destLabel("Orange Corp fortress")}</div></div>
            <div><span className="pill ok">Uploading</span></div>
            <div className="m">184 KB · 60%</div>
          </div>
          <div className="row">
            <span className="dot"></span>
            <div className="who"><b>“Refactor probe grading”</b><div className="sub">next in queue, to {destLabel("My let.ai space")}</div></div>
            <div><span className="pill off">Queued</span></div>
            <div className="m">61 KB</div>
          </div>
          <div className="rowdiv">Sent in the last hour · 4 of 138 today</div>
          {SENT.map((row) => <SentRowEl key={row[0]} row={row} />)}
          {!showEarlier ? (
            <div style={{ padding: "14px 4px 6px" }}><button className="btn ghost sm" id="showEarlierBtn" onClick={() => setShowEarlier(true)}>Show earlier today (134 more)</button></div>
          ) : (
            <>
              <div className="rowdiv">Earlier today</div>
              {EARLIER.map((row) => <SentRowEl key={row[0]} row={row} />)}
              <div style={{ padding: "12px 4px 4px", fontSize: 14, color: "var(--text-subtle)" }}>Showing 7 of 138 sends today — the complete record lives in <a href="#" onClick={(e) => { e.preventDefault(); goto("logs"); }}>Client Logs → Uploads</a>.</div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Data Sent</h2>
        <div className="h2sub">Last 24 hours, in MB per hour — hover any bar for the exact numbers.</div>
        <Chart />
      </div>
    </section>
  );
}
