import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  api,
  type DestinationInfo,
  type FolderInfo,
  type LogLine,
  type ProbeInfo,
  type SessionInfo,
  type Snapshot,
} from "./api";

export type View = "overview" | "folders" | "activity" | "privacy" | "device" | "logs" | "fortress";
export type GroupBy = "tool" | "dir" | "dest";

const SNAPSHOT_POLL_MS = 5_000;
const LOGS_POLL_MS = 4_000;

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

const VIEW_KEYS: Record<string, View> = { "1": "overview", "2": "folders", "3": "activity", "4": "privacy", "5": "device", "6": "logs" };

interface AppState {
  view: View;
  goto: (v: View) => void;
  currentDest: string | null;
  openDest: (key: string) => void;

  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  query: string;
  setQuery: (q: string) => void;
  openRows: Set<string>;
  toggleRow: (id: string) => void;

  doctorOpen: boolean;
  setDoctorOpen: (b: boolean) => void;
  kbdOpen: boolean;
  setKbdOpen: (b: boolean) => void;
  inspOpen: boolean;
  setInspOpen: (b: boolean) => void;
  inspInitialPath: string | null;
  openInspector: (path?: string) => void;
  logFull: boolean;
  setLogFull: (b: boolean) => void;

  // Live data
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  email: string | null;
  probe: ProbeInfo | null;
  probing: boolean;
  runProbe: () => void;
  logs: LogLine[];
  sessionsFor: (folderId: string) => SessionInfo[] | undefined;
  loadSessions: (folderId: string) => void;
  previewFor: (path: string) => { role: string; text: string }[] | undefined;
  loadPreview: (path: string) => void;

  // Derived
  activeFolders: FolderInfo[];
  destinations: DestinationInfo[];
  foldersOfDest: (destKey: string) => FolderInfo[];
  destLabels: (f: FolderInfo) => string[];
  unlinkedFolders: FolderInfo[];

  reviewUnlinked: (folderId: string) => void;
  jumpFortressList: () => void;
  jumpDoctor: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useApp outside provider");
  return s;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("overview");
  const [currentDest, setCurrentDest] = useState<string | null>(null);
  const [groupBy, setGroupByState] = useState<GroupBy>("tool");
  const [query, setQueryState] = useState("");
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [kbdOpen, setKbdOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const [inspInitialPath, setInspInitialPath] = useState<string | null>(null);
  const [logFull, setLogFull] = useState(false);

  const openInspector = (path?: string) => {
    setInspInitialPath(path ?? null);
    setInspOpen(true);
  };

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [sessions, setSessions] = useState<Map<string, SessionInfo[]>>(new Map());
  const [previews, setPreviews] = useState<Map<string, { role: string; text: string }[]>>(new Map());
  const sessionsInFlight = useRef<Set<string>>(new Set());
  const previewsInFlight = useRef<Set<string>>(new Set());

  // ── polling ───────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const s = await api.snapshot();
        if (!alive) return;
        setSnap(s);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void pull();
    const t = setInterval(pull, SNAPSHOT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    void api.whoami().then((w) => setEmail(w.email)).catch(() => {});
  }, []);

  const logsActive = view === "logs" || logFull;
  useEffect(() => {
    if (!logsActive) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await api.logs(500);
        if (alive) setLogs(r.lines);
      } catch {
        // snapshot polling surfaces connectivity problems; keep last lines
      }
    };
    void pull();
    const t = setInterval(pull, LOGS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [logsActive]);

  const goto = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  const openDest = (key: string) => {
    setCurrentDest(key);
    goto("fortress");
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

  const runProbe = () => {
    setProbing(true);
    void api
      .probe()
      .then(setProbe)
      .catch(() => setProbe({ up: false, reason: "probe failed" }))
      .finally(() => setProbing(false));
  };

  const loadSessions = (folderId: string) => {
    if (sessions.has(folderId) || sessionsInFlight.current.has(folderId)) return;
    sessionsInFlight.current.add(folderId);
    void api
      .sessions(folderId)
      .then((list) => setSessions((prev) => new Map(prev).set(folderId, list)))
      .catch(() => {})
      .finally(() => sessionsInFlight.current.delete(folderId));
  };

  const loadPreview = (path: string) => {
    if (previews.has(path) || previewsInFlight.current.has(path)) return;
    previewsInFlight.current.add(path);
    void api
      .sessionPreview(path)
      .then((r) => setPreviews((prev) => new Map(prev).set(path, r.lines)))
      .catch(() => setPreviews((prev) => new Map(prev).set(path, [])))
      .finally(() => previewsInFlight.current.delete(path));
  };

  const activeFolders = snap?.folders ?? [];
  const destinations = snap?.destinations ?? [];
  const foldersOfDest = (destKey: string) => activeFolders.filter((f) => f.dests.includes(destKey));
  const destLabels = (f: FolderInfo) =>
    f.dests.length > 0
      ? f.dests.map((key) => destinations.find((d) => d.key === key)?.label ?? key)
      : ["not uploaded yet"];
  const unlinkedFolders = activeFolders.filter((f) => f.unlinkedRepo);

  // Review → land on the exact folder row being reviewed, highlighted.
  const reviewUnlinked = (folderId: string) => {
    flushSync(() => {
      setGroupByState("tool");
      setOpenRows(new Set());
      setView("folders");
    });
    window.scrollTo(0, 0);
    const row = document.querySelector(`#folderList .frow[data-id="${CSS.escape(folderId)}"]`);
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
    view, goto, currentDest, openDest,
    groupBy, setGroupBy, query, setQuery, openRows, toggleRow,
    doctorOpen, setDoctorOpen,
    kbdOpen, setKbdOpen, inspOpen, setInspOpen, inspInitialPath, openInspector,
    logFull, setLogFull,
    snap, loading, error, email,
    probe, probing, runProbe,
    logs,
    sessionsFor: (id) => sessions.get(id),
    loadSessions,
    previewFor: (p) => previews.get(p),
    loadPreview,
    activeFolders, destinations, foldersOfDest, destLabels, unlinkedFolders,
    reviewUnlinked, jumpFortressList, jumpDoctor,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
