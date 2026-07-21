import { useEffect, useState } from "react";
import { useApp } from "../store";
import { MonitorIc, MoonSunIc } from "../icons";

export function Topbar() {
  const { goto, deviceName, deviceConnected, personalOn } = useApp();
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const [popQuality, setPopQuality] = useState("Excellent — 26 ms · 13.3 MB/s");
  const [popLast, setPopLast] = useState("12 seconds ago");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="topbar">
      <div className="mark"><i></i><i></i><i></i><i></i></div>
      <div className="wordmark">HX Client</div>

      <div className="chip" id="connChip" style={{ marginLeft: 8 }}>
        <span className="dot" id="connDot" style={{ background: deviceConnected ? "var(--ok)" : "var(--border-strong)" }}></span> <span id="connLabel">{deviceConnected ? "Connected" : "Disconnected"}</span>
        <div className="pop left">
          <div className="plbl">Connection</div>
          <span id="popQuality">{popQuality}</span>
          <div className="plbl">Signed in via</div>
          let.ai <span className="psub">· beta environment</span>
          <div className="plbl">Last contact</div>
          <span id="popLast">{popLast}</span>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="btn ghost sm" id="popTestBtn" onClick={() => { setPopQuality("Excellent — 25 ms · 13.1 MB/s"); setPopLast("just now"); }}>Test connection</button>
            <button className="btn ghost sm" onClick={() => goto("device")}>Sync Engine →</button>
          </div>
        </div>
      </div>

      <div className="spacer"></div>

      <button className="iconbtn" id="themeBtn" title="Switch theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        <MoonSunIc dark={theme === "dark"} />
      </button>

      <div className="chip click" id="deviceChip" onClick={() => goto("device")}>
        <MonitorIc />
        <b className="devname">{deviceName}</b>
        <div className="pop">
          <div className="pname devname">{deviceName}</div>
          <div className="psub">Linux arm64 · container · <code className="hx">hx</code> 76.2.4</div>
          <div className="plbl">Right now</div>
          Syncing normally — 2 sessions waiting
          <div style={{ marginTop: 14 }}><span style={{ color: "var(--accent)", fontWeight: 600 }}>Click for device detail →</span></div>
        </div>
      </div>

      <div className="chip">
        <span className="avatar">JO</span> <b>Johnny Orange</b>
        <div className="pop">
          <div className="pname">Johnny Orange</div>
          <div className="psub">signed in on this device</div>
          <div className="plbl">Companies</div>
          orange-corp · nordbank
          <div className="plbl">Personal sessions</div>
          <span id="popPersonal">{personalOn ? "Syncing to my private space" : "Staying on this machine"}</span>
        </div>
      </div>
    </div>
  );
}
