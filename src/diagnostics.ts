import type { SyncReport, SyncSkippedEntry } from "./watch.js";
import type { FileSkipReason, SyncBlockerDestination } from "./state.js";
import type { ResolvedRoots, RootOrigin } from "./roots.js";
import { formatOutage, type SyncLedger } from "./ledger.js";
import { collapseHome } from "./settings.js";

export interface DoctorSession {
  family: string;
  sessionId: string;
}

export interface DoctorRemediation {
  fortressSettingsUrl: string | null;
  repositorySettingsUrl: string | null;
  guidance: string;
  retryCommand: "hx retry --blocked";
}

export interface DoctorBlocker {
  reason: FileSkipReason;
  sessionCount: number;
  sessions: DoctorSession[];
  destination: SyncBlockerDestination | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  nextRetryAt: string | null;
  remediation: DoctorRemediation;
}

export interface DoctorRoot {
  family: "claude" | "codex";
  configDir: string;
  origin: RootOrigin;
  exists: boolean;
}

export interface SyncDoctorReport {
  ok: boolean;
  generatedAt: string;
  sync: {
    total: number;
    done: number;
    percent: number;
    totalBytes: number;
  };
  blockedSessions: number;
  gaps: {
    sessions: number;
    localFileDeleted: number;
    outsideScanWindow: number;
  };
  blockers: DoctorBlocker[];
  /** Every session in exactly one bucket + the health percentage. Unlike
   *  `sync` above (a min-across-destinations count kept for the gateway's
   *  wire format) this is what `hx status` shows. */
  ledger: SyncLedger;
  /** The data roots the report was computed over (empty on legacy callers). */
  roots: DoctorRoot[];
  /** Partially-synced sessions under no current root (a removed data root) —
   *  informational, not an error: nothing will pick them up as configured. */
  unwatchedSessions: number;
}

interface MutableBlocker {
  reason: FileSkipReason;
  destination: SyncBlockerDestination | null;
  sessions: Map<string, DoctorSession>;
  firstObservedAtMs: number | null;
  lastObservedAtMs: number | null;
  nextRetryAtMs: number | null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function originOf(gatewayBaseUrl: string): string | null {
  try {
    return new URL(gatewayBaseUrl).origin;
  } catch {
    return null;
  }
}

function settingsUrls(
  gatewayBaseUrl: string,
  destination: SyncBlockerDestination | null,
): DoctorRemediation {
  const origin = originOf(gatewayBaseUrl);
  const org = destination?.orgSlug;
  const project = destination?.projectSlug;
  return {
    fortressSettingsUrl:
      origin && org ? `${origin}/${encodeURIComponent(org)}/settings#fortress` : null,
    repositorySettingsUrl:
      origin && org && project
        ? `${origin}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/settings#repositories`
        : null,
    guidance:
      "Bring the Fortress online, or detach/move the repository to a project backed by a live Fortress.",
    retryCommand: "hx retry --blocked",
  };
}

function destinationKey(reason: FileSkipReason, destination: SyncBlockerDestination | null): string {
  if (!destination) return `${reason}:legacy`;
  return [
    reason,
    destination.vaultOrgId,
    destination.projectId ?? "",
    destination.repoSlug ?? "",
  ].join(":");
}

/** Group skipped files by the destination actually holding them. The output
 * deliberately excludes local paths and all transcript/content fields. */
export function groupSyncBlockers(skipped: SyncSkippedEntry[]): MutableBlocker[] {
  const groups = new Map<string, MutableBlocker>();
  for (const entry of skipped) {
    const destinations = entry.blocker?.destinations.length
      ? entry.blocker.destinations
      : [null];
    for (const destination of destinations) {
      const key = destinationKey(entry.reason, destination);
      let group = groups.get(key);
      if (!group) {
        group = {
          reason: entry.reason,
          destination,
          sessions: new Map(),
          firstObservedAtMs: null,
          lastObservedAtMs: null,
          nextRetryAtMs: null,
        };
        groups.set(key, group);
      }
      group.sessions.set(`${entry.family}:${entry.sessionId}`, {
        family: entry.family,
        sessionId: entry.sessionId,
      });
      const first = entry.blocker?.firstSeenAtMs;
      const last = entry.blocker?.lastSeenAtMs;
      const next = entry.nextAttemptAtMs;
      if (first !== undefined) {
        group.firstObservedAtMs =
          group.firstObservedAtMs === null ? first : Math.min(group.firstObservedAtMs, first);
      }
      if (last !== undefined) {
        group.lastObservedAtMs =
          group.lastObservedAtMs === null ? last : Math.max(group.lastObservedAtMs, last);
      }
      if (next !== undefined) {
        group.nextRetryAtMs =
          group.nextRetryAtMs === null ? next : Math.min(group.nextRetryAtMs, next);
      }
    }
  }
  return [...groups.values()];
}

export function buildSyncDoctorReport(
  report: SyncReport,
  gatewayBaseUrl: string,
  nowMs = Date.now(),
  roots: ResolvedRoots | null = null,
): SyncDoctorReport {
  const groups = groupSyncBlockers(report.skipped);
  const blockedSessionKeys = new Set(
    report.skipped.map((entry) => `${entry.family}:${entry.sessionId}`),
  );
  const gone = new Set(report.behind.filter((entry) => entry.sourceGone).map((entry) => entry.sessionId));
  const aged = new Set(
    report.behind
      .filter((entry) => !entry.sourceGone && !gone.has(entry.sessionId))
      .map((entry) => entry.sessionId),
  );
  const percent =
    report.snapshot.total === 0
      ? 100
      : Math.floor((report.snapshot.done / report.snapshot.total) * 100);
  const blockers = groups.map((group): DoctorBlocker => ({
    reason: group.reason,
    sessionCount: group.sessions.size,
    sessions: [...group.sessions.values()].sort((a, b) =>
      `${a.family}:${a.sessionId}`.localeCompare(`${b.family}:${b.sessionId}`),
    ),
    destination: group.destination,
    firstObservedAt: iso(group.firstObservedAtMs),
    lastObservedAt: iso(group.lastObservedAtMs),
    nextRetryAt: iso(group.nextRetryAtMs),
    remediation: settingsUrls(gatewayBaseUrl, group.destination),
  }));
  const gapSessions = new Set([...gone, ...aged]).size;
  return {
    ok:
      blockedSessionKeys.size === 0 &&
      gapSessions === 0 &&
      report.snapshot.done >= report.snapshot.total,
    generatedAt: new Date(nowMs).toISOString(),
    sync: {
      total: report.snapshot.total,
      done: report.snapshot.done,
      percent,
      totalBytes: report.snapshot.totalBytes,
    },
    blockedSessions: blockedSessionKeys.size,
    gaps: {
      sessions: gapSessions,
      localFileDeleted: gone.size,
      outsideScanWindow: aged.size,
    },
    blockers,
    ledger: report.ledger,
    roots: roots
      ? [
          ...roots.claude.map((r): DoctorRoot => ({ family: "claude", configDir: r.configDir, origin: r.origin, exists: r.exists })),
          ...roots.codex.map((r): DoctorRoot => ({ family: "codex", configDir: r.configDir, origin: r.origin, exists: r.exists })),
        ]
      : [],
    unwatchedSessions: report.unwatched,
  };
}

function shortDate(value: string, nowMs = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const sameYear = date.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
    timeZone: "UTC",
  }).format(date);
}

/** Compact root cause used by the default `hx status` table. */
export function formatStatusBlocker(skipped: SyncSkippedEntry[], nowMs = Date.now()): string {
  const groups = groupSyncBlockers(skipped);
  const sessions = new Set(skipped.map((entry) => `${entry.family}:${entry.sessionId}`)).size;
  if (groups.length !== 1 || !groups[0]?.destination) {
    if (groups.length === 1) {
      return `${sessions} session${sessions === 1 ? "" : "s"} — destination store unavailable`;
    }
    return `${sessions} session${sessions === 1 ? "" : "s"} across ${groups.length} blocked destination${groups.length === 1 ? "" : "s"}`;
  }
  const d = groups[0].destination;
  const org = d.orgName ?? d.orgSlug ?? d.vaultOrgId;
  const heartbeat = d.lastSeenAt ? ` since ${shortDate(d.lastSeenAt, nowMs)}` : "";
  const repo = d.repoSlug ? ` · ${d.repoSlug}` : "";
  return `${sessions} session${sessions === 1 ? "" : "s"} — ${org} Fortress offline${heartbeat}${repo}`;
}

/** Right-align a count in a fixed gutter so the bucket column scans. */
function num(n: number, width = 6): string {
  return String(n).padStart(width);
}

/**
 * The session ledger, shown with its arithmetic. Printing the sum and the
 * formula makes the headline percentage auditable — a reader can check that
 * the buckets account for every session rather than trusting the number.
 */
export function formatLedgerSection(ledger: SyncLedger): string[] {
  const lines = [
    "",
    "SESSIONS",
    `  Delivered   ${num(ledger.delivered)}   reached every reachable destination`,
  ];
  if (ledger.uploading > 0) {
    lines.push(`  Uploading   ${num(ledger.uploading)}   bytes still going to a reachable store`);
  }
  if (ledger.inProgress > 0) {
    lines.push(`  In progress ${num(ledger.inProgress)}   still being written`);
  }
  if (ledger.waiting > 0) {
    lines.push(`  Waiting     ${num(ledger.waiting)}   an offline Fortress owes bytes`);
  }
  if (ledger.incomplete > 0) {
    lines.push(`  Incomplete  ${num(ledger.incomplete)}   source file gone before upload finished`);
  }
  lines.push(`              ${"─".repeat(6)}`);
  lines.push(`              ${num(ledger.total)}`);
  const sendable = ledger.delivered + ledger.uploading + ledger.incomplete;
  lines.push(
    `  Sync ${ledger.percent}% = ${ledger.delivered} delivered / ${sendable} sendable` +
      ` (in-progress and waiting sessions are excluded — nothing you can act on)`,
  );
  if (ledger.lagging.length > 0) {
    lines.push("");
    lines.push("OFFLINE DESTINATIONS");
    for (const d of ledger.lagging) {
      const seen = d.lastSeenAt ? ` · last seen ${d.lastSeenAt}` : " · never seen";
      lines.push(`  ${d.label}  —  ${d.sessions} waiting · ${formatOutage(d.offlineDays)}${seen}`);
    }
    lines.push(
      "  Counts overlap where one session fans out to more than one Fortress.",
    );
  }
  return lines;
}

/** Session ids shown per destination before the list is summarised. A device
 *  fanning a whole history at an offline store lists hundreds otherwise, which
 *  buries the remediation links under an unreadable wall. Automation reads
 *  `--json`, which is never truncated. */
const MAX_LISTED_SESSIONS = 8;

function formatSessionList(sessions: DoctorSession[]): string {
  const shown = sessions.slice(0, MAX_LISTED_SESSIONS);
  const rest = sessions.length - shown.length;
  const list = shown.map((s) => `${s.family}:${s.sessionId}`).join(", ");
  return rest > 0 ? `${list} …and ${rest} more (see --json)` : list;
}

export function formatSyncDoctorText(report: SyncDoctorReport): string {
  // Lead with the ledger percentage, not report.sync — the latter is the
  // min-across-destinations count kept for the gateway wire format, and it
  // would contradict the number `hx status` just printed.
  const lines = ["HX sync — detailed", ...formatLedgerSection(report.ledger).slice(1)];
  if (report.roots.length > 0) {
    lines.push(
      `Watching: ${report.roots
        .map(
          (r) =>
            `${collapseHome(r.configDir)}${r.origin === "default" ? "" : ` [${r.origin}]`}${r.exists ? "" : " (missing)"}`,
        )
        .join(" · ")}`,
    );
  }
  if (report.blockedSessions === 0) {
    lines.push("Blocked: none");
  } else {
    lines.push(`Blocked: ${report.blockedSessions} session${report.blockedSessions === 1 ? "" : "s"}`);
    report.blockers.forEach((blocker, index) => {
      const d = blocker.destination;
      lines.push("");
      lines.push(`Destination ${index + 1}: ${d?.orgName ?? d?.orgSlug ?? d?.vaultOrgId ?? "unknown store"}`);
      if (d?.projectName || d?.projectSlug) lines.push(`  Project: ${d.projectName ?? d.projectSlug}`);
      if (d?.repoSlug) lines.push(`  Repo: ${d.repoSlug}`);
      lines.push(`  Reason: ${blocker.reason}`);
      lines.push(`  Fix: ${blocker.remediation.guidance}`);
      if (d?.lastSeenAt) lines.push(`  Fortress last heartbeat: ${d.lastSeenAt}`);
      if (blocker.nextRetryAt) lines.push(`  Next automatic retry: ${blocker.nextRetryAt}`);
      lines.push(`  Sessions: ${formatSessionList(blocker.sessions)}`);
      if (blocker.remediation.fortressSettingsUrl) {
        lines.push(`  Fortress settings: ${blocker.remediation.fortressSettingsUrl}`);
      }
      if (blocker.remediation.repositorySettingsUrl) {
        lines.push(`  Repository attachment: ${blocker.remediation.repositorySettingsUrl}`);
      }
    });
    lines.push("");
    lines.push("After fixing the destination or repository attachment:");
    lines.push("  hx retry --blocked");
    lines.push("  hx status");
  }
  if (report.gaps.sessions > 0) {
    lines.push("");
    lines.push(
      `Sync gaps: ${report.gaps.sessions} session${report.gaps.sessions === 1 ? "" : "s"} (${report.gaps.localFileDeleted} deleted locally, ${report.gaps.outsideScanWindow} outside the scan window)`,
    );
  }
  if (report.unwatchedSessions > 0) {
    lines.push("");
    lines.push(
      `Unwatched: ${report.unwatchedSessions} partially-synced session${report.unwatchedSessions === 1 ? "" : "s"} under locations no longer watched (removed data root)`,
    );
  }
  // Held is not lost. Say so explicitly: four warning paragraphs above read as
  // data loss without it, and the whole point of excluding waiting sessions
  // from the percentage is that they are safe on disk.
  if (report.ledger.waiting > 0) {
    lines.push("");
    lines.push(
      `Nothing is lost — all ${report.ledger.waiting} waiting session${report.ledger.waiting === 1 ? " is" : "s are"} still on disk and retrying.`,
    );
  }
  if (report.ok) lines.push("Result: healthy — 100% uploaded");
  return lines.join("\n");
}
