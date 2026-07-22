import { useEffect } from "react";
import { AppProvider, useApp } from "./store";
import { Topbar } from "./components/Topbar";
import { SideNav } from "./components/SideNav";
import { FooterBand } from "./components/FooterBand";
import { Overview } from "./views/Overview";
import { Folders } from "./views/Folders";
import { SyncStatus } from "./views/SyncStatus";
import { Privacy } from "./views/Privacy";
import { DeviceDetail } from "./views/DeviceDetail";
import { FortressDetail } from "./views/FortressDetail";
import { Logs } from "./views/Logs";
import { KbdModal } from "./modals/KbdModal";
import { InspectorModal } from "./modals/InspectorModal";
import { ConfirmModal } from "./modals/ConfirmModal";

function Chrome() {
  const { snap, error, loading } = useApp();
  const deviceName = snap?.device.name;
  useEffect(() => {
    document.title = deviceName ? `HX Client — ${deviceName}` : "HX Client";
  }, [deviceName]);
  if (loading && !snap) {
    return <div className="bootstate">Loading…</div>;
  }
  if (error && !snap) {
    return (
      <div className="bootstate">
        <b>Can’t reach the hx ui server.</b>
        <p>Start it with <code className="hx">hx ui</code> and open the printed link — the address bar link carries a one-time key this page needs.</p>
      </div>
    );
  }
  return (
    <>
      <Topbar />
      <div className="shell">
        <SideNav />
        <main>
          <Overview />
          <Folders />
          <SyncStatus />
          <Privacy />
          <DeviceDetail />
          <FortressDetail />
          <Logs />
        </main>
      </div>
      <FooterBand />
      <KbdModal />
      <InspectorModal />
      <ConfirmModal />
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Chrome />
    </AppProvider>
  );
}
