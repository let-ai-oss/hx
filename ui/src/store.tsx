import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { FOLDERS, type Folder, type Fortress } from "./data";

export type View = "overview" | "folders" | "activity" | "privacy" | "device" | "logs" | "fortress";
export type GroupBy = "tool" | "dir" | "dest" | "person";
export interface PauseState { msg: string; forever: boolean; }

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Re-triggerable one-shot CSS animation, same trick as the prototype.
export function retrigger(el: Element, cls: string) {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

export function copyText(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  } catch {
    return false;
  }
}

const fmtT = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const VIEW_KEYS: Record<string, View> = { "1": "overview", "2": "folders", "3": "activity", "4": "privacy", "5": "device", "6": "logs" };

interface AppState {
  view: View;
  goto: (v: View) => void;
  currentFortress: string | null;
  openFortress: (id: string) => void;

  personalOn: boolean;
  applyPersonal: (on: boolean) => void;

  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  query: string;
  setQuery: (q: string) => void;
  openRows: Set<string>;
  toggleRow: (id: string) => void;

  excluded: Set<string>;
  excludeFolder: (id: string) => void;
  includeFolder: (id: string) => void;
  recentlyIncluded: string[];

  manualExclusions: string[];
  addRule: (v: string) => void;
  removeRule: (v: string) => void;

  pause: PauseState | null;
  pickPause: (p: string) => void;
  resumeAll: () => void;

  deviceName: string;
  setDeviceName: (n: string) => void;
  deviceConnected: boolean;
  setDeviceConnected: (b: boolean) => void;

  doctorOpen: boolean;
  setDoctorOpen: (b: boolean) => void;

  kbdOpen: boolean;
  setKbdOpen: (b: boolean) => void;
  inspOpen: boolean;
  setInspOpen: (b: boolean) => void;
  logFull: boolean;
  setLogFull: (b: boolean) => void;

  reviewUnlinked: () => void;
  jumpFortressList: () => void;
  jumpDoctor: () => void;

  activeFolders: Folder[];
  fortressFolders: (ft: Fortress) => Folder[];
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useApp outside provider");
  return s;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("overview");
  const [currentFortress, setCurrentFortress] = useState<string | null>(null);
  const [personalOn, setPersonalOn] = useState(true);
  const [groupBy, setGroupByState] = useState<GroupBy>("tool");
  const [query, setQueryState] = useState("");
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [recentlyIncluded, setRecentlyIncluded] = useState<string[]>([]);
  const [manualExclusions, setManualExclusions] = useState<string[]>(["~/personal-finance"]);
  const [pause, setPause] = useState<PauseState | null>(null);
  const [deviceName, setDeviceName] = useState("claude-container");
  const [deviceConnected, setDeviceConnected] = useState(true);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const [logFull, setLogFull] = useState(false);

  const goto = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  const openFortress = (id: string) => {
    setCurrentFortress(id);
    goto("fortress");
  };

  const applyPersonal = (on: boolean) => {
    setPersonalOn(on);
    setOpenRows(new Set());
  };

  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    setOpenRows(new Set());
  };

  const setQuery = (q: string) => {
    setQueryState(q);
    setOpenRows(new Set());
  };

  const toggleRow = (id: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const excludeFolder = (id: string) => {
    setExcluded((prev) => new Set(prev).add(id));
    setOpenRows(new Set());
  };

  // Excluding is instant; re-including kicks off a history back-fill, so
  // take the user to Sync Status where that progress is visible.
  const includeFolder = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setRecentlyIncluded((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setOpenRows(new Set());
    goto("activity");
  };

  const addRule = (v: string) => {
    setManualExclusions((prev) => (prev.includes(v) ? prev : [...prev, v]));
  };
  const removeRule = (v: string) => {
    setManualExclusions((prev) => prev.filter((p) => p !== v));
  };

  const pickPause = (p: string) => {
    if (p === "forever") {
      setPause({ msg: "Paused until I resume it", forever: true });
      return;
    }
    let until: Date;
    if (p === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      until = d;
    } else {
      until = new Date(Date.now() + Number(p) * 60000);
    }
    const mins = Math.max(1, Math.round((until.getTime() - Date.now()) / 60000));
    const when = mins >= 16 * 60 ? `tomorrow at ${fmtT(until)}` : `at ${fmtT(until)}`;
    setPause({ msg: `Paused — resumes ${when} · in ${mins >= 60 ? Math.round(mins / 60) + "h" : mins + " min"}`, forever: false });
  };
  const resumeAll = () => setPause(null);

  // Review → land on the exact row being reviewed, highlighted.
  const reviewUnlinked = () => {
    flushSync(() => {
      setGroupByState("tool");
      setOpenRows(new Set());
      setView("folders");
    });
    window.scrollTo(0, 0);
    const row = document.querySelector('#folderList .frow[data-id="rind"]');
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      retrigger(row, "flashrow");
    }
  };

  const jumpFortressList = () => {
    const p = document.getElementById("fortressPanel");
    if (!p) return;
    p.scrollIntoView({ behavior: "smooth", block: "center" });
    retrigger(p, "flash");
  };

  const jumpDoctor = () => {
    flushSync(() => {
      setView("device");
      setDoctorOpen(true);
    });
    window.scrollTo(0, 0);
    const mp = document.getElementById("doctorBtn")?.closest(".panel");
    if (mp) {
      mp.scrollIntoView({ behavior: "smooth", block: "center" });
      retrigger(mp, "flash");
    }
  };

  const activeFolders = FOLDERS.filter((f) => !excluded.has(f.id));
  const fortressFolders = (ft: Fortress) =>
    FOLDERS.filter((f) => !excluded.has(f.id) && f.dest === ft.destMatch && (!f.personal || personalOn));

  // Keyboard: ? for the menu, 1–6 for sections, Esc for dialogs / fullscreen logs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (logFull) {
          setLogFull(false);
          return;
        }
        setKbdOpen(false);
        setInspOpen(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        setKbdOpen((o) => !o);
        return;
      }
      const v = VIEW_KEYS[e.key];
      if (v) goto(v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFull]);

  const value: AppState = {
    view, goto, currentFortress, openFortress,
    personalOn, applyPersonal,
    groupBy, setGroupBy, query, setQuery, openRows, toggleRow,
    excluded, excludeFolder, includeFolder, recentlyIncluded,
    manualExclusions, addRule, removeRule,
    pause, pickPause, resumeAll,
    deviceName, setDeviceName, deviceConnected, setDeviceConnected,
    doctorOpen, setDoctorOpen,
    kbdOpen, setKbdOpen, inspOpen, setInspOpen, logFull, setLogFull,
    reviewUnlinked, jumpFortressList, jumpDoctor,
    activeFolders, fortressFolders,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
