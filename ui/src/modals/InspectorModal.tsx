import { useState, type ReactNode } from "react";
import { useApp } from "../store";
import { INSPECT } from "../data";
import { SearchIc } from "../icons";

export function InspectorModal() {
  const { inspOpen, setInspOpen } = useApp();
  const [inspSel, setInspSel] = useState("i1");
  const [inspQuery, setInspQuery] = useState("");

  const qq = inspQuery.trim();
  const q = qq.toLowerCase();
  const items = INSPECT.filter((x) => !q || (x.title + " " + x.dest + " " + x.status).toLowerCase().includes(q));

  // Case-insensitive match highlighting in the list.
  const hl = (s: string): ReactNode => {
    if (!q) return s;
    const rx = new RegExp(`(${qq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    const parts = s.split(rx);
    return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="hl">{p}</mark> : p));
  };

  const x = INSPECT.find((i) => i.id === inspSel) ?? INSPECT[0];

  return (
    <div className={`overlayw${inspOpen ? " open" : ""}`} id="inspOverlay" onClick={(e) => { if (e.target === e.currentTarget) setInspOpen(false); }}>
      <div className="modal" style={{ width: "min(900px,100%)" }}>
        <div className="mhead">
          <div className="row1"><h3>What Leaves This Machine</h3><button className="x" onClick={() => setInspOpen(false)}>✕</button></div>
          <p className="msub">A preview of text that <code className="hx">hx</code> has queued (or recently sent).</p>
        </div>
        <div className="mbody scrolly">
          <div className="insp">
            <div className="listcol">
              <div className="search compact" style={{ flex: "none", width: "100%" }}>
                <SearchIc />
                <input id="inspFilter" placeholder="Filter sessions…" value={inspQuery} onChange={(e) => setInspQuery(e.target.value)} />
              </div>
              <div className="ilist scrolly" id="inspList">
                {items.length ? items.map((it) => (
                  <div key={it.id} className={`item${it.id === inspSel ? " sel" : ""}`} onClick={() => setInspSel(it.id)}>
                    <b>{hl(it.title)}</b><span className="s">{hl(`${it.status} · ${it.size}`)}</span>
                  </div>
                )) : (
                  <div className="item" style={{ color: "var(--text-subtle)" }}>No matches.</div>
                )}
              </div>
            </div>
            <div>
              <div className="headr" id="inspHead">
                <span className={`pill ${x.kind}`}>{x.dest}</span><span className="m">{x.size} · {x.status}</span>
              </div>
              <div className="transcript scrolly" id="inspBody">
                {x.lines.map(([r, t], i) => (
                  <div key={i}><span className={r === "Tool" ? "toolr" : "role"}>{r}:</span> {t}</div>
                ))}
                <div style={{ color: "var(--text-subtle)", marginTop: 8 }}>… preview ends here — the full transcript is {x.size}</div>
              </div>
              <div className="honesty" id="inspFoot">The full {x.size} transcript is exactly what uploads to {x.dest} — nothing else is read or sent.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
