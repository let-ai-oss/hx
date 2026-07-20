import { useState } from "react";
import { copyText, useApp } from "../store";
import { LOG_LINES } from "../data";
import { GPill } from "../components/GPill";
import { CheckIc, CopyIc, MaxiMiniIc, SearchIc } from "../icons";

const LEVEL_LABEL: Record<"all" | "up" | "warn", string> = { all: "Everything", up: "Uploads", warn: "Warnings & errors" };
const LEVEL_OPTIONS: ["all" | "up" | "warn", string][] = [["all", "Everything"], ["up", "Uploads"], ["warn", "Warnings & errors"]];

export function Logs() {
  const { view, deviceName, logFull, setLogFull } = useApp();
  const [level, setLevel] = useState<"all" | "up" | "warn">("all");
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const q = filter.trim();
  const ql = q.toLowerCase();
  const visible = LOG_LINES.map((l) => {
    const okLevel = level === "all" || l.level === level;
    const okText = !ql || (l.ts + l.body).toLowerCase().includes(ql);
    return okLevel && okText;
  });
  const shown = visible.filter(Boolean).length;
  const total = LOG_LINES.length;

  const copyVisible = () => {
    const text = LOG_LINES.filter((_, i) => visible[i]).map((l) => l.ts + l.body).join("\n");
    if (copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <section className={`view${view === "logs" ? " active" : ""}`} id="view-logs">
      <div className="kicker">System</div>
      <h1>Client Logs</h1>
      <p className="lede">The one technical page — the <code className="hx">hx</code> daemon’s own words, for when something needs a closer look. Logs stay on this machine.</p>

      <div id="logShell" className={logFull ? "full" : undefined}>
        <div className="logtitle">Client Logs — <span className="devname">{deviceName}</span></div>
        <div className="logbar">
          <GPill id="logLevelPill" label="Show" value={LEVEL_LABEL[level]} valueId="logLevelVal" menuId="logLevelMenu" open={levelMenuOpen} setOpen={setLevelMenuOpen}>
            {LEVEL_OPTIONS.map(([lf, label]) => (
              <button key={lf} className={level === lf ? "sel" : undefined} onClick={() => { setLevel(lf); setLevelMenuOpen(false); }}>{label}</button>
            ))}
          </GPill>
          <div className="search compact">
            <SearchIc />
            <input id="logFilter" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <span style={{ flex: 1 }}></span>
          <button className="iconbtn" id="logCopyBtn" title="Copy visible rows" onClick={copyVisible}>
            {copied ? <CheckIc /> : <CopyIc />}
          </button>
          <button className={`fpill${autoScroll ? " sel" : ""}`} id="autoScrollBtn" onClick={() => setAutoScroll(!autoScroll)}>Auto-scroll: {autoScroll ? "On" : "Off"}</button>
          <button className="btn ghost">Download</button>
          <button className="iconbtn" id="logMaxBtn" title="Full-page view" onClick={() => setLogFull(!logFull)}>
            <MaxiMiniIc full={logFull} />
          </button>
        </div>
        <div className={`minibanner${q.length > 0 ? " on" : ""}`} id="logFilterBanner">
          <span id="logFilterText">{q.length > 0 ? `Filtering rows in real time for “${q}” — showing ${shown} of ${total}.` : ""}</span>
          <span style={{ flex: 1 }}></span>
          <button className="btn link sm" id="logFilterClear" onClick={() => setFilter("")}>Clear</button>
        </div>
        <div className="logpane scrolly" id="logPane">
          {LOG_LINES.map((l, i) => (
            <div key={i} className={`ln${l.level === "up" ? " up" : l.level === "warn" ? " warnl" : ""}`} data-l={l.level} style={{ display: visible[i] ? "" : "none" }}>
              <span className="ts">{l.ts}</span>{l.body}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>Log Files on Disk</h2>
        <PathRow k="Full log" p="~/.let/hx/stdout.log" />
        <PathRow k="Errors only" p="~/.let/hx/stderr.log" />
      </div>
    </section>
  );
}

function PathRow({ k, p }: { k: string; p: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pathrow">
      <span className="k">{k}</span><span className="p">{p}</span>
      <button className="btn ghost sm" onClick={() => { if (copyText(p)) { setCopied(true); setTimeout(() => setCopied(false), 1200); } }}>{copied ? "Copied" : "Copy path"}</button>
    </div>
  );
}
