// Three-step chunked upload:
//   1. POST /sessions/append-url     → { chunkId, uploadUrl }
//   2. PUT  <uploadUrl> <bytes>          (direct to GCS)
//   3. POST /sessions/commit         → gateway runs GCS Compose

import type { HxConfig } from "./config.js";
import type { Family } from "./sources.js";
import type { HxCcdGroupMirrorBlob } from "./mirror-types.js";
import { assertSecureFetchUrl } from "./net.js";

/** One fan-out target for a chunk. `ready` carries a signed staging URL; `held`
 *  means that org's vault is offline right now — skip it this pass and retry. */
export type AppendDestination =
  | {
      vaultOrgId: string | null;
      chunkId: string;
      uploadUrl: string;
      objectName: string;
      expiresAt: string;
      status: "ready";
    }
  | { vaultOrgId: string; status: "held"; reason: "vault_offline"; orgName: string | null };

export interface AppendUrlResponse {
  chunkId: string;
  uploadUrl: string;
  objectName: string;
  expiresAt: string;
  /** The store org the gateway resolved for this chunk (null = let.ai-hosted).
   *  Carried back at commit so both steps write to the same store. Absent from a
   *  gateway that predates per-session routing. */
  vaultOrgId?: string | null;
  /** Every distinct store this chunk should fan out to (the legacy fields above
   *  mirror the first ready one). Absent from a gateway that predates fan-out →
   *  treat as the single legacy destination. */
  destinations?: AppendDestination[];
}

export interface CommitMeta {
  sourcePath?: string;
  title?: string | null;
  /** CCD title provenance ("user" | "ai" | "fallback"). */
  titleSource?: "user" | "ai" | "fallback" | null;
  /** CCD's internal session id ("local_<uuid>") for group mapping. */
  ccdSessionId?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  /** Canonical lowercase `owner/name` GitHub slug for the session's repo. */
  repoSlug?: string | null;
  entrypoint?: string | null;
  originator?: string | null;
  modelProvider?: string | null;
  lastUserText?: string | null;
  lastAssistantText?: string | null;
  eventCount?: number;
  userTextCount?: number;
  assistantCount?: number;
  lastActivityAt?: string | null;
}

/**
 * HTTP failure from a gateway/storage call, carrying the status code so the
 * watcher can tell a wholesale outage from a single bad request.
 */
export class HxHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HxHttpError";
  }

  /** 429 + 5xx mean the gateway/storage can't accept uploads right now (rate
   *  limit, vault offline, gateway down). The pipeline should pause and retry
   *  later rather than re-POST every pending file on every 1.5s poll. Other 4xx
   *  are per-request faults that shouldn't stall the whole daemon. */
  get serverUnavailable(): boolean {
    return this.status === 429 || this.status >= 500;
  }

  /** A 503 whose body names vault_offline: THIS session's vault is down while
   *  the gateway itself is healthy. Callers should skip just this file with a
   *  long per-file backoff instead of pausing the whole pass — other sessions
   *  (and other stores) keep uploading. */
  get vaultOffline(): boolean {
    return this.status === 503 && this.message.includes("vault_offline");
  }
}

async function throwHttp(res: Response, label: string): Promise<never> {
  const txt = await res.text().catch(() => "");
  throw new HxHttpError(res.status, `${label} failed: ${res.status} ${txt.slice(0, 200)}`);
}

function authHeaders(cfg: HxConfig): Record<string, string> {
  // Chokepoint for every token-bearing gateway POST in this module: the device
  // bearer token must never leave over cleartext. Assert the configured gateway
  // is https (loopback http excepted) here so a downgraded/hand-edited
  // `cfg.gatewayBaseUrl` fails closed before the token is put on the wire,
  // matching the guard resolveRoute already applies to the same URL.
  assertSecureFetchUrl(cfg.gatewayBaseUrl, "gateway request");
  return {
    authorization: `Bearer ${cfg.accessToken}`,
    "content-type": "application/json",
  };
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// Liveness ping the watcher sends on a timer (and once on start) so the
// gateway knows the daemon is alive even when there's nothing to upload.
// Best-effort: the caller swallows transient failures — the next beat, or any
// real upload, refreshes lastSeenAt just the same.
export async function sendHeartbeat(cfg: HxConfig): Promise<void> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/devices/heartbeat`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: "{}",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`heartbeat failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

/** Catch-up progress the watcher reports as it works through the on-disk
 *  backlog. `total`/`done` are session counts; `totalBytes` is the on-disk size
 *  of ALL those sessions (the whole payload — not the part already sent).
 *  Drives the Devices page + `hx status` sync indicators. */
export interface SyncSnapshot {
  total: number;
  done: number;
  totalBytes: number;
}

// Report the daemon's catch-up progress so the Devices page can show a sync
// bar while a freshly connected machine streams its history up. Best-effort,
// like the heartbeat — a dropped report just means the bar updates on the next
// one; the next real upload refreshes liveness regardless.
export async function sendSyncStatus(cfg: HxConfig, snap: SyncSnapshot): Promise<void> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/devices/sync-status`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`sync-status failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

export async function requestAppendUrl(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; byteCount: number; repoSlug?: string | null },
): Promise<AppendUrlResponse> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/append-url`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) await throwHttp(res, "append-url");
  return (await res.json()) as AppendUrlResponse;
}

export async function putChunk(uploadUrl: string, bytes: Buffer): Promise<void> {
  // `uploadUrl` is a signed target the gateway just handed us (append-url
  // response / a fan-out destination). It carries the session bytes, so refuse
  // to PUT it over cleartext to a non-loopback host — an impersonated gateway
  // could otherwise redirect an upload to http and exfiltrate transcripts.
  assertSecureFetchUrl(uploadUrl, "PUT chunk");
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson" },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) await throwHttp(res, "PUT chunk");
}

export async function commitChunk(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    chunkId: string;
    /** Replace the canonical with this chunk instead of appending — sent on the
     *  first chunk of any from-zero upload so a server canonical that diverged
     *  from this file (wiped store, lost local state) converges back to the
     *  source instead of accreting duplicate bytes. Gateways that predate the
     *  flag ignore it and append, today's behavior. */
    replace?: boolean;
    /** The store org append-url resolved, echoed back so commit writes to the
     *  same store. `null` (let.ai) is sent verbatim; only `undefined` is dropped. */
    vaultOrgId?: string | null;
    meta?: CommitMeta;
  },
): Promise<{ ok: true; totalBytes: number; componentCount: number }> {
  const body = {
    family: args.family,
    sessionId: args.sessionId,
    chunkId: args.chunkId,
    replace: args.replace || undefined,
    vaultOrgId: args.vaultOrgId,
    meta: args.meta
      ? dropNulls(args.meta as unknown as Record<string, unknown>)
      : undefined,
  };
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/commit`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttp(res, "commit");
  return (await res.json()) as { ok: true; totalBytes: number; componentCount: number };
}

// ── Child execution lanes (subagents + workflow agents) ────────────────────
// Same 3-step chunked contract as the parent transcript, against dedicated
// endpoints (an old gateway 404s these — child bytes must never compose into
// the parent canonical by accident).

export interface AgentCommitMeta {
  kind: "subagent" | "workflow_agent";
  runId?: string | null;
  /** Parent tool_use id from agent-<id>.meta.json — the child↔parent join. */
  toolUseId?: string | null;
  agentType?: string | null;
  label?: string | null;
  worktreePath?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  eventCount?: number;
  lastActivityAt?: string | null;
}

export async function requestAgentAppendUrl(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; agentId: string; byteCount: number },
): Promise<AppendUrlResponse> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/agent-append-url`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) await throwHttp(res, "agent-append-url");
  return (await res.json()) as AppendUrlResponse;
}

export async function commitAgentChunk(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    agentId: string;
    chunkId: string;
    /** Replace the child canonical instead of appending — sent on the first
     *  chunk of any from-zero upload (divergence repair, like the parent's).
     *  No feature detection: the agent endpoints and the flag ship together. */
    replace?: boolean;
    vaultOrgId?: string | null;
    meta?: AgentCommitMeta;
  },
): Promise<{ ok: true; totalBytes: number; componentCount: number }> {
  const body = {
    family: args.family,
    sessionId: args.sessionId,
    agentId: args.agentId,
    chunkId: args.chunkId,
    replace: args.replace || undefined,
    vaultOrgId: args.vaultOrgId,
    meta: args.meta
      ? dropNulls(args.meta as unknown as Record<string, unknown>)
      : undefined,
  };
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/agent-commit`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttp(res, "agent-commit");
  return (await res.json()) as { ok: true; totalBytes: number; componentCount: number };
}

/** Workflow-run sidecar: persisted script + journal.jsonl, whole-file,
 *  hash-gated by the caller. */
export async function uploadWorkflowRun(
  cfg: HxConfig,
  args: {
    family: Family;
    sessionId: string;
    runId: string;
    scriptName?: string | null;
    script?: string | null;
    journal?: string | null;
  },
): Promise<{ ok: true }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/workflow`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(dropNulls(args as unknown as Record<string, unknown>)),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`workflow upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true };
}

/** Agent-team mirror — the device's ~/.claude/teams/* configs, rewritten in
 *  place. Hash-gated by the caller; empty teams still uploads (clears state). */
export async function uploadTeamMirror(
  cfg: HxConfig,
  mirror: { teams: Array<{ name: string; config: unknown }>; syncedAtMs?: number | null },
): Promise<{ ok: true; teams: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/team-mirror`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ mirror }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`team-mirror upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; teams: number };
}

// ── Canonical divergence audit ──────────────────────────────────────────────
// Ask the gateway to compare, per session, the canonical object's ACTUAL size
// in the store against the bytes this device believes it has uploaded (its
// persisted offset). "divergent" means the store lost or mangled the canonical
// (e.g. an ephemeral-filesystem deploy wiped it) — the watcher responds by
// resetting that file's offset to 0, which re-uploads it with replace:true.

export interface VerifySessionsItem {
  family: Family;
  sessionId: string;
  byteCount: number;
}

export interface VerifySessionsResult {
  family: string;
  sessionId: string;
  status: "ok" | "divergent" | "skipped";
  storeBytes: number | null;
}

export async function verifySessions(
  cfg: HxConfig,
  sessions: VerifySessionsItem[],
): Promise<VerifySessionsResult[]> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/verify`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ sessions }),
  });
  if (!res.ok) await throwHttp(res, "verify");
  const json = (await res.json()) as { results: VerifySessionsResult[] };
  return json.results;
}

// ── Sidecar artifacts (tasks / plan) ───────────────────────────────────────
// Whole-file uploads — small JSON/markdown rewritten in place, so there's no
// append/compose; the gateway just overwrites the canonical sidecar object.

export async function uploadTasks(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; tasks: unknown[] },
): Promise<{ ok: true; count: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/tasks`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tasks upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; count: number };
}

export async function uploadPlan(
  cfg: HxConfig,
  args: { family: Family; sessionId: string; planFilePath: string; content: string },
): Promise<{ ok: true }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/plan`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`plan upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true };
}

// CCD sidebar group mirror — the device's whole grouping, rewritten in place.
// Hash-gated by the caller so an unchanged mirror never re-uploads.
export async function uploadGroupMirror(
  cfg: HxConfig,
  mirror: HxCcdGroupMirrorBlob,
): Promise<{ ok: true; groups: number }> {
  const res = await fetch(`${cfg.gatewayBaseUrl}/sessions/group-mirror`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ mirror }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`group-mirror upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: true; groups: number };
}
