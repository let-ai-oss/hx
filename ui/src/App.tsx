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

function Chrome() {
  const { deviceName } = useApp();
  useEffect(() => {
    document.title = `HX UI — ${deviceName}`;
  }, [deviceName]);
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
