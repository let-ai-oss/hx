import type { SyncReport, SyncSkippedEntry } from "./watch.js";
import type { FileSkipReason, SyncBlockerDestination } from "./state.js";

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

export function formatSyncDoctorText(report: SyncDoctorReport): string {
  const lines = [
    "HX sync doctor",
    `Sync: ${report.sync.percent}% — ${report.sync.done} / ${report.sync.total} sessions`,
  ];
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
      lines.push(
        `  Sessions: ${blocker.sessions.map((session) => `${session.family}:${session.sessionId}`).join(", ")}`,
      );
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
  if (report.ok) lines.push("Result: healthy — 100% uploaded");
  return lines.join("\n");
}
