// Read-only view-model providers for the HX Client UI.
//
// Everything here READS: discovery, ~/.let/hx state/config, the daemon's
// stdout log, and two harmless gateway GETs (whoami, ping via probe). No
// provider mutates daemon state — state.json stays daemon-owned.
//
// The server process is long-lived while the daemon keeps writing, so every
// snapshot resets the in-process state cache before reading (loadState caches
// forever per process by design) and re-reads config per request.

import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig, type HxConfig } from "../config.js";
import { getDaemonOps, STDOUT_LOG } from "../daemon.js";
import { buildSyncDoctorReport, type SyncDoctorReport } from "../diagnostics.js";
import { assertSecureFetchUrl } from "../net.js";
import { readActivity, type ActivityEntry } from "../activity.js";
import { readOrgNames } from "../org-names.js";
import { discoverAll, readHead, type DiscoveredFile, type HeadMeta } from "../sources.js";
import { extractTitleFallback, readHeadLines } from "./preview.js";
import { loadState, minOffset, resetStateCache, type FileState } from "../state.js";
import { HX_VERSION } from "../version.js";
import { computeSyncReport } from "../watch.js";

export const FAMILY_LABELS: Record<string, string> = {
  "claude-cli": "Claude Code CLI",
  "claude-desktop": "Claude Code Desktop",
  "codex-cli": "Codex CLI",
  "codex-desktop": "Codex Desktop",
  unknown: "Unknown tool",
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

/** "letai" (shared let.ai store) or a vault org id — friendly name when the
 *  daemon has ever learned one, short id otherwise. */
export function destLabelFor(destKey: string, names: Record<string, string> = {}): string {
  if (destKey === "letai") return "let.ai";
  const known = names[destKey];
  if (known) return known;
  return destKey.length > 14 ? `${destKey.slice(0, 12)}…` : destKey;
}

export interface FolderVM {
  id: string; // `${family}:${cwd}`
  family: string;
  tool: string;
  path: string;
  sessions: number;
  repo: string | null;
  branch: string | null;
  /** Destination store keys observed in state offsets ("letai" | org id). */
  dests: string[];
  lastUploadAtMs: number;
  /** Repo detected but every observed upload went only to the personal store. */
  unlinkedRepo: boolean;
  /** Gateway enrichment (device-folders/mine) — absent on older gateways. */
  workspace: { orgName: string; projectName: string } | null;
  sharing: {
    orgName: string;
    sharing: boolean;
    teams: { name: string; accentColor: string | null }[];
    people: string[];
    peopleCount: number;
  } | null;
}

export interface SessionVM {
  id: string;
  path: string;
  title: string;
  sizeBytes: number;
  uploadedBytes: number;
  pendingBytes: number;
  lastUploadAtMs: number;
  dests: string[];
}

export interface DestinationVM {
  key: string;
  label: string;
  personal: boolean;
  sessions: number;
  folders: number;
  bytes: number;
  lastUploadAtMs: number;
  blocked: { sessions: number; reason: string; orgName: string | null } | null;
  /** Vault display info from the gateway — absent on older gateways. */
  storage: { kind: string | null; region: string | null; status: string } | null;
}

export interface RecentUploadVM {
  atMs: number;
  title: string;
  folder: string;
  family: string;
  dests: string[];
  sizeBytes: number;
}

export interface UiSnapshot {
  generatedAt: number;
  device: {
    name: string | null;
    platform: string;
    arch: string;
    hxVersion: string;
    connected: boolean;
    gatewayHost: string | null;
    daemon: { managerName: string; loaded: boolean; pid: number | null };
  };
  sync: {
    total: number;
    done: number;
    totalBytes: number;
    behind: number;
    waiting: number;
    lastUploadAtMs: number;
  };
  folders: FolderVM[];
  destinations: DestinationVM[];
  recent: RecentUploadVM[];
  doctor: SyncDoctorReport;
}

// readHead is cheap (≤64 lines) but folders hold hundreds of files; cache
// heads per (path, mtime) across snapshots. Sessions without an explicit
// title get one derived from their first user message (same rule the
// workbench uses for fallback titles).
const headCache = new Map<string, { mtimeMs: number; head: HeadMeta }>();

async function headsFor(files: DiscoveredFile[]): Promise<Map<string, HeadMeta>> {
  const out = new Map<string, HeadMeta>();
  const POOL = 16;
  for (let i = 0; i < files.length; i += POOL) {
    await Promise.all(
      files.slice(i, i + POOL).map(async (f) => {
        const cached = headCache.get(f.path);
        if (cached && cached.mtimeMs === f.mtimeMs) {
          out.set(f.path, cached.head);
          return;
        }
        const head = await readHead(f.path, f.source);
        if (!head.title) {
          head.title = extractTitleFallback(await readHeadLines(f.path));
        }
        headCache.set(f.path, { mtimeMs: f.mtimeMs, head });
        out.set(f.path, head);
      }),
    );
  }
  return out;
}

const homePrefix = `${os.homedir()}`;

function collapseHome(p: string): string {
  return p.startsWith(homePrefix) ? `~${p.slice(homePrefix.length)}` : p;
}

export interface FileFacts {
  file: DiscoveredFile;
  head: HeadMeta;
  state: FileState | null;
}

export function folderIdFor(family: string, cwd: string): string {
  return `${family}:${cwd}`;
}

/** Pure fold of per-file facts into folder rows — unit-tested. */
export function groupFolders(facts: FileFacts[]): FolderVM[] {
  const byId = new Map<string, FolderVM>();
  for (const { file, head, state } of facts) {
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    const id = folderIdFor(family, cwd);
    let row = byId.get(id);
    if (!row) {
      row = {
        id,
        family,
        tool: familyLabel(family),
        path: cwd,
        sessions: 0,
        repo: null,
        branch: null,
        dests: [],
        lastUploadAtMs: 0,
        unlinkedRepo: false,
        workspace: null,
        sharing: null,
      };
      byId.set(id, row);
    }
    row.sessions += 1;
    if (head.repoSlug && !row.repo) row.repo = head.repoSlug;
    if (head.gitBranch && !row.branch) row.branch = head.gitBranch;
    if (state) {
      row.lastUploadAtMs = Math.max(row.lastUploadAtMs, state.lastUploadAtMs || 0);
      for (const key of Object.keys(state.offsets)) {
        if ((state.offsets[key] ?? 0) > 0 && !row.dests.includes(key)) row.dests.push(key);
      }
    }
  }
  for (const row of byId.values()) {
    row.dests.sort();
    row.unlinkedRepo =
      row.repo !== null && row.dests.length > 0 && row.dests.every((d) => d === "letai");
  }
  return [...byId.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Pure fold of per-file facts into destination rows — unit-tested. */
export function groupDestinations(
  facts: FileFacts[],
  names: Record<string, string> = {},
): DestinationVM[] {
  const byKey = new Map<string, DestinationVM & { folderIds: Set<string> }>();
  for (const { file, head, state } of facts) {
    if (!state) continue;
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    for (const [key, uploaded] of Object.entries(state.offsets)) {
      if ((uploaded ?? 0) <= 0) continue;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          label: destLabelFor(key, names),
          personal: key === "letai",
          sessions: 0,
          folders: 0,
          bytes: 0,
          lastUploadAtMs: 0,
          blocked: null,
          storage: null,
          folderIds: new Set<string>(),
        };
        byKey.set(key, row);
      }
      row.sessions += 1;
      row.bytes += uploaded ?? 0;
      row.lastUploadAtMs = Math.max(row.lastUploadAtMs, state.lastUploadAtMs || 0);
      row.folderIds.add(folderIdFor(family, cwd));
    }
    const blocker = state.blocker;
    if (blocker) {
      for (const dest of blocker.destinations) {
        const key = dest.vaultOrgId;
        const row = byKey.get(key);
        if (row) {
          row.blocked = {
            sessions: (row.blocked?.sessions ?? 0) + 1,
            reason: blocker.reason,
            orgName: dest.orgName ?? row.blocked?.orgName ?? null,
          };
          if (dest.orgName) row.label = dest.orgName;
        }
      }
    }
  }
  return [...byKey.values()]
    .map(({ folderIds, ...row }) => ({ ...row, folders: folderIds.size }))
    .sort((a, b) => (a.personal ? 1 : 0) - (b.personal ? 1 : 0) || b.bytes - a.bytes);
}

async function collectFacts(): Promise<FileFacts[]> {
  const files = await discoverAll();
  const heads = await headsFor(files);
  const state = await loadState();
  return files.map((file) => ({
    file,
    head: heads.get(file.path) as HeadMeta,
    state: state.files[file.path] ?? null,
  }));
}

export async function buildSnapshot(): Promise<UiSnapshot> {
  resetStateCache();
  const cfg = await readConfig();
  const facts = await collectFacts();
  const report = await computeSyncReport();
  const doctor = buildSyncDoctorReport(report, cfg?.gatewayBaseUrl ?? "");

  let daemon = { managerName: "none", loaded: false, pid: null as number | null };
  try {
    const ops = getDaemonOps();
    const state = await ops.state();
    daemon = { managerName: ops.managerName, loaded: state.loaded, pid: state.pid };
  } catch {
    // unsupported platform — report as not running
  }

  const folders = groupFolders(facts);
  const destinations = groupDestinations(facts, await readOrgNames());
  applyEnrichment(folders, destinations, await cachedEnrichment());
  const lastUploadAtMs = facts.reduce((m, f) => Math.max(m, f.state?.lastUploadAtMs ?? 0), 0);

  const gatewayHost = ((): string | null => {
    try {
      return cfg?.gatewayBaseUrl ? new URL(cfg.gatewayBaseUrl).host : null;
    } catch {
      return null;
    }
  })();

  return {
    generatedAt: Date.now(),
    device: {
      name: cfg?.deviceName ?? null,
      platform: os.platform(),
      arch: os.arch(),
      hxVersion: HX_VERSION,
      connected: Boolean(cfg?.accessToken),
      gatewayHost,
      daemon,
    },
    sync: {
      total: report.snapshot.total,
      done: report.snapshot.done,
      totalBytes: report.snapshot.totalBytes,
      behind: report.behind.length,
      waiting: report.skipped.length,
      lastUploadAtMs,
    },
    folders,
    destinations,
    recent: facts
      .filter((f) => (f.state?.lastUploadAtMs ?? 0) > 0)
      .sort((a, b) => (b.state?.lastUploadAtMs ?? 0) - (a.state?.lastUploadAtMs ?? 0))
      .slice(0, 20)
      .map(({ file, head, state }) => ({
        atMs: state?.lastUploadAtMs ?? 0,
        title: head.title ?? path.basename(file.path),
        folder: collapseHome(head.cwd ?? path.dirname(file.path)),
        family: head.family,
        dests: Object.keys(state?.offsets ?? {}).filter((k) => (state?.offsets[k] ?? 0) > 0),
        sizeBytes: file.size,
      })),
    doctor,
  };
}

export async function buildSessions(folderId: string): Promise<SessionVM[]> {
  resetStateCache();
  const facts = await collectFacts();
  const out: SessionVM[] = [];
  for (const { file, head, state } of facts) {
    const family = head.family === "unknown" ? (file.source === "claude" ? "claude-cli" : "codex-cli") : head.family;
    const cwd = collapseHome(head.cwd ?? path.dirname(file.path));
    if (folderIdFor(family, cwd) !== folderId) continue;
    const uploaded = state ? minOffset(state) : 0;
    out.push({
      id: head.sessionId ?? path.basename(file.path),
      path: file.path,
      title: head.title ?? path.basename(file.path, ".jsonl"),
      sizeBytes: file.size,
      uploadedBytes: uploaded,
      pendingBytes: Math.max(0, file.size - uploaded),
      lastUploadAtMs: state?.lastUploadAtMs ?? 0,
      dests: Object.keys(state?.offsets ?? {}).filter((k) => (state?.offsets[k] ?? 0) > 0),
    });
  }
  return out.sort((a, b) => b.lastUploadAtMs - a.lastUploadAtMs);
}

/** Only paths the discovery scan yields may be previewed or sized. */
export async function isDiscoveredPath(p: string): Promise<boolean> {
  const files = await discoverAll();
  return files.some((f) => f.path === p);
}

export type LogLevel = "info" | "up" | "warn";

/** Pure log-line classifier — unit-tested. */
export function classifyLogLine(body: string): LogLevel {
  if (/\(\+[\d,]+B/.test(body)) return "up";
  if (/failed=[1-9]/.test(body)) return "warn";
  if (/\[error\]|error[:\s]|warn|not progressing|backing off|unavailable/i.test(body)) {
    return "warn";
  }
  return "info";
}

const LOG_TAIL_MAX = 256 * 1024;

export async function tailDaemonLog(maxLines: number): Promise<{ body: string; level: LogLevel }[]> {
  try {
    // Open first, size via fstat on the handle — no stat-then-open race.
    const fh = await open(STDOUT_LOG, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - LOG_TAIL_MAX);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift(); // first line is torn
      return lines
        .filter((l) => l.trim().length > 0)
        .slice(-maxLines)
        .map((body) => ({ body, level: classifyLogLine(body) }));
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

// ── device-folders/mine enrichment (workspace, sharing, vault labels) ──
// Newer gateways serve the same folder inventory the workbench's My Devices
// page uses, scoped to this device's own sessions. Cached briefly; an older
// gateway (404) caches null so every snapshot doesn't re-ask.

interface GatewayFolder {
  path: string;
  folderQuery: string;
  repoSlug: string | null;
  workspaces: { orgId: string; orgName: string; projectId: string; projectName: string }[];
  sharing: {
    orgId: string;
    orgName: string;
    sharing: boolean;
    teams: { id: string; name: string; accentColor: string | null }[];
    people: { userId: string; name: string }[];
    peopleCount: number;
  } | null;
}

interface GatewayVault {
  orgId: string;
  orgName: string;
  storageKind: string | null;
  bucketRegion: string | null;
  status: string;
}

interface Enrichment {
  folders: GatewayFolder[];
  vaults: Record<string, GatewayVault>;
}

let enrichmentCache: { at: number; value: Enrichment | null } | null = null;
const ENRICHMENT_TTL_MS = 60_000;

async function cachedEnrichment(fetcher: typeof fetch = fetch): Promise<Enrichment | null> {
  if (enrichmentCache && Date.now() - enrichmentCache.at < ENRICHMENT_TTL_MS) {
    return enrichmentCache.value;
  }
  const cfg = await readConfig();
  if (!cfg?.accessToken || !cfg.gatewayBaseUrl) return null;
  try {
    const url = `${cfg.gatewayBaseUrl}/device-folders/mine`;
    assertSecureFetchUrl(url, "gateway");
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
    const value = res.ok ? ((await res.json()) as Enrichment) : null;
    enrichmentCache = { at: Date.now(), value };
    return value;
  } catch {
    enrichmentCache = { at: Date.now(), value: null };
    return null;
  }
}

/** Pure: fold gateway folder rows onto locally-derived folders — exact path
 *  match first, then worktree-group prefix match. Unit-tested. */
export function applyEnrichment(
  folders: FolderVM[],
  destinations: DestinationVM[],
  enrichment: Enrichment | null,
): void {
  if (!enrichment) return;
  const collapsed = enrichment.folders.map((g) => ({
    g,
    path: collapseHome(g.path),
    prefix: g.folderQuery.endsWith("/") ? collapseHome(g.folderQuery) : null,
  }));
  for (const f of folders) {
    const hit =
      collapsed.find((c) => c.path === f.path) ??
      collapsed.find((c) => c.prefix !== null && `${f.path}/`.startsWith(c.prefix));
    if (!hit) continue;
    const primary = hit.g.workspaces[0];
    f.workspace = primary ? { orgName: primary.orgName, projectName: primary.projectName } : null;
    f.sharing = hit.g.sharing
      ? {
          orgName: hit.g.sharing.orgName,
          sharing: hit.g.sharing.sharing,
          teams: hit.g.sharing.teams.map((t) => ({ name: t.name, accentColor: t.accentColor })),
          people: hit.g.sharing.people.map((p) => p.name),
          peopleCount: hit.g.sharing.peopleCount,
        }
      : null;
  }
  for (const d of destinations) {
    const vault = enrichment.vaults[d.key];
    if (!vault) continue;
    d.label = vault.orgName;
    d.storage = {
      kind: vault.storageKind,
      region: vault.bucketRegion,
      status: vault.status,
    };
  }
}

// ── whoami (email for the identity chip) — cached, token never exposed ──
let whoamiCache: { at: number; email: string | null } | null = null;
const WHOAMI_TTL_MS = 5 * 60_000;

export async function cachedWhoami(fetcher: typeof fetch = fetch): Promise<{ email: string | null }> {
  if (whoamiCache && Date.now() - whoamiCache.at < WHOAMI_TTL_MS) {
    return { email: whoamiCache.email };
  }
  const cfg = await readConfig();
  if (!cfg?.accessToken || !cfg.gatewayBaseUrl) return { email: null };
  try {
    const url = `${cfg.gatewayBaseUrl}/whoami`;
    assertSecureFetchUrl(url, "gateway");
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: AbortSignal.timeout(6_000),
    });
    const email = res.ok ? ((await res.json()) as { email?: string }).email ?? null : null;
    whoamiCache = { at: Date.now(), email };
    return { email };
  } catch {
    whoamiCache = { at: Date.now(), email: null };
    return { email: null };
  }
}

export async function readConfigForProbe(): Promise<HxConfig | null> {
  return readConfig();
}

const ACTIVITY_MAX_HOURS = 7 * 24;

export async function activitySince(hours: number): Promise<ActivityEntry[]> {
  const h = Math.min(ACTIVITY_MAX_HOURS, Math.max(1, hours));
  return readActivity(Date.now() - h * 3_600_000);
}
