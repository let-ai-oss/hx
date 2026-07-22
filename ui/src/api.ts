// API client for the hx ui server. Auth: the launch token arrives in the URL
// fragment (#k=…), gets exchanged once for a session token kept in
// sessionStorage, and rides every call in the x-hx-ui-token header. The
// fragment is scrubbed from the address bar after the exchange.

export interface DeviceInfo {
  name: string | null;
  platform: string;
  arch: string;
  hxVersion: string;
  connected: boolean;
  gatewayHost: string | null;
  daemon: { managerName: string; loaded: boolean; pid: number | null };
}

export interface SyncInfo {
  total: number;
  done: number;
  totalBytes: number;
  behind: number;
  waiting: number;
  lastUploadAtMs: number;
}

export interface FolderInfo {
  id: string;
  family: string;
  tool: string;
  path: string;
  sessions: number;
  repo: string | null;
  branch: string | null;
  dests: string[];
  lastUploadAtMs: number;
  attributed: boolean | null;
  unlinkedRepo: boolean;
  workspace: { orgName: string; projectName: string } | null;
  sharing: {
    orgName: string;
    sharing: boolean;
    teams: { name: string; accentColor: string | null }[];
    people: string[];
    peopleCount: number;
  } | null;
}

export interface DestinationInfo {
  key: string;
  label: string;
  personal: boolean;
  sessions: number;
  folders: number;
  bytes: number;
  lastUploadAtMs: number;
  blocked: { sessions: number; reason: string; orgName: string | null } | null;
  storage: { kind: string | null; region: string | null; status: string } | null;
}

export interface RecentUpload {
  atMs: number;
  title: string;
  folder: string;
  family: string;
  dests: string[];
  sizeBytes: number;
}

export interface DoctorBlockerInfo {
  reason: string;
  sessions: number;
  orgName?: string | null;
  nextRetryAtMs?: number | null;
}

export interface DoctorInfo {
  ok: boolean;
  generatedAt: string;
  sync: { total: number; done: number; percent: number; totalBytes: number };
  blockedSessions: number;
  gaps: { sessions: number; localFileDeleted: number; outsideScanWindow: number };
  blockers: DoctorBlockerInfo[];
}

export interface Snapshot {
  generatedAt: number;
  device: DeviceInfo;
  sync: SyncInfo;
  folders: FolderInfo[];
  destinations: DestinationInfo[];
  recent: RecentUpload[];
  doctor: DoctorInfo;
}

export interface SessionInfo {
  id: string;
  path: string;
  title: string;
  sizeBytes: number;
  uploadedBytes: number;
  pendingBytes: number;
  lastUploadAtMs: number;
  dests: string[];
}

export interface LogLine {
  body: string;
  level: "info" | "up" | "warn";
}

export interface ActivityEntry {
  at: number;
  sessionId: string;
  family: string;
  bytes: number;
  dest: string;
}

export interface ProbeInfo {
  up: boolean;
  reason?: string;
  latencyMs?: number;
  bytesPerSec?: number;
  quality?: string;
}

export interface ExcludedFolder {
  family: string;
  cwd: string;
}

export interface Settings {
  pause: { untilMs: number | null } | null;
  personalSync: boolean;
  excludedFolders: ExcludedFolder[];
  excludeRules: string[];
}

export interface DaemonActionResult {
  managerName: string;
  loaded: boolean;
  pid: number | null;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export type ServerEvent =
  | { type: "hello" }
  | { type: "changed" }
  | { type: "update-progress"; phase: string; pct?: number }
  | { type: "update-done"; alreadyLatest: boolean; version: string; daemonRestarted: boolean }
  | { type: "update-error"; message: string };

const TOKEN_KEY = "hx-ui-session-token";

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function bootstrapToken(): Promise<string | null> {
  const cached = sessionStorage.getItem(TOKEN_KEY);
  if (cached) return cached;
  const match = /[#&]k=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) return null;
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: match[1] }),
  });
  if (!res.ok) return null;
  const { sessionToken } = (await res.json()) as { sessionToken: string };
  sessionStorage.setItem(TOKEN_KEY, sessionToken);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return sessionToken;
}

let tokenPromise: Promise<string | null> | null = null;

function sessionToken(): Promise<string | null> {
  tokenPromise ??= bootstrapToken();
  return tokenPromise;
}

async function get<T>(path: string): Promise<T> {
  const token = await sessionToken();
  if (!token) throw new ApiError(401, "no session token — reopen from `hx ui`");
  const res = await fetch(path, { headers: { "x-hx-ui-token": token } });
  if (!res.ok) throw new ApiError(res.status, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const token = await sessionToken();
  if (!token) throw new ApiError(401, "no session token — reopen from `hx ui`");
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "x-hx-ui-token": token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Server-sent events over an authenticated fetch stream (EventSource can't
 * set headers). Returns an aborter; auto-reconnects with a small backoff so a
 * restarted `hx ui` picks the page back up.
 */
export function subscribeEvents(onEvent: (evt: ServerEvent) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;

  const connect = async (): Promise<void> => {
    while (!stopped) {
      try {
        const token = await sessionToken();
        if (!token) return;
        ctrl = new AbortController();
        const res = await fetch("/api/events", {
          headers: { "x-hx-ui-token": token },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new ApiError(res.status, "events unavailable");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as ServerEvent);
            } catch {
              // malformed frame — skip
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3_000));
    }
  };
  void connect();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

export const api = {
  snapshot: () => get<Snapshot>("/api/snapshot"),
  sessions: (folderId: string) =>
    get<SessionInfo[]>(`/api/sessions?folder=${encodeURIComponent(folderId)}`),
  sessionPreview: (path: string) =>
    get<{ lines: { role: "Me" | "Agent" | "Tool"; text: string }[] }>(
      `/api/session-preview?path=${encodeURIComponent(path)}`,
    ),
  logs: (lines: number) => get<{ lines: LogLine[] }>(`/api/logs?lines=${lines}`),
  probe: () => get<ProbeInfo>("/api/probe"),
  whoami: () => get<{ email: string | null }>("/api/whoami"),
  activity: (hours: number) => get<{ entries: ActivityEntry[] }>(`/api/activity?hours=${hours}`),
  settings: () => get<Settings>("/api/settings"),
  patchSettings: (patch: Partial<Settings>) => post<Settings>("/api/settings", patch),
  daemon: (action: "start" | "stop" | "restart") =>
    post<DaemonActionResult>("/api/daemon", { action }),
  retryBlocked: () => post<{ sessions: number; restarted: boolean }>("/api/retry-blocked"),
  updateCheck: () => get<UpdateCheck>("/api/update-check"),
  startUpdate: () => post<{ started: boolean }>("/api/update"),
  disconnect: () => post<{ disconnected: boolean }>("/api/disconnect"),
};

// ── formatting helpers shared by the views ──────────────────────────────

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtRelative(atMs: number, nowMs = Date.now()): string {
  if (!atMs) return "never";
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtClock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Display label for a destination store key when no friendlier name exists. */
export function destDisplay(dests: string[], all: DestinationInfo[]): string[] {
  return dests.map((key) => all.find((d) => d.key === key)?.label ?? key);
}
