// mtime-poll watcher.
//
// Mirrors glancer's strategy: poll the candidate directories at ~1.5s
// intervals, walk the cache of per-file mtimes, and trigger an upload when
// (mtime, size) move. fs.watch + chokidar were considered and rejected for
// the same reasons as glancer — too many directories, FD pressure under
// `~/.claude/projects/<encoded-path>/...`.
//
// Per-file upload pipeline:
//   1. read bytes from `state.offset → EOF`
//   2. request signed PUT URL
//   3. PUT bytes
//   4. POST commit (gateway composes into canonical)
//   5. bump state.offset

import { stat, open } from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_PROJECTS_DIR,
  CODEX_ARCHIVED_DIR,
  CODEX_SESSIONS_DIR,
  type DiscoveredChildFile,
  type DiscoveredFile,
  type DiscoveredWorkflowRun,
  discoverClaudeChildren,
  discoverClaudeFiles,
  discoverCodexFiles,
  readHead,
} from "./sources.js";
import {
  type FileState,
  type HxState,
  type StateScope,
  getArtifactHash,
  getFileState,
  loadState,
  minOffset,
  offsetFor,
  setArtifactHash,
  setOffsetFor,
  touchMtime,
  upsertFileState,
} from "./state.js";
import { planFanout } from "./fanout.js";
import { type HxConfig } from "./config.js";
import { resolveRoute, type Route } from "./route.js";
import {
  commitAgentChunk,
  commitChunk,
  HxHttpError,
  putChunk,
  requestAgentAppendUrl,
  requestAppendUrl,
  sendHeartbeat,
  sendSyncStatus,
  type SyncSnapshot,
  uploadGroupMirror,
  uploadPlan,
  uploadTasks,
  uploadTeamMirror,
  uploadWorkflowRun,
  verifySessions,
} from "./uploader.js";
import { summariseChunk } from "./parse.js";
import { getCcdRecentsByCliId } from "./ccd.js";
import { buildGroupMirror } from "./ccd-prefs.js";
import {
  findPlanPathInText,
  hashContent,
  listTaskSessionIds,
  readAgentMeta,
  readPlanFile,
  readPlanForJsonl,
  readTaskSet,
  readTeamConfigs,
  readTextFile,
} from "./artifacts.js";

const FAST_POLL_MS = 1_500;
// When the gateway stops accepting uploads (vault offline, 5xx, rate limit),
// retrying the whole backlog every FAST_POLL_MS is what floods the API and
// makes it unresponsive. Instead we pause uploads and back off exponentially
// from this base up to this cap, resetting to the normal cadence on the first
// pass that makes progress. Heartbeats keep their own timer, so liveness holds.
const UPLOAD_BACKOFF_BASE_MS = 5_000;
const UPLOAD_BACKOFF_MAX_MS = 5 * 60_000;
// How often the daemon announces liveness when idle. Uploads already refresh
// lastSeenAt, so a beat only fires when nothing has contacted the gateway for
// this long — keeping idle traffic to ~1 tiny request/minute. The gateway's
// "live" window is a small multiple of this so a couple of missed beats (sleep,
// flaky link) don't immediately read as offline.
const HEARTBEAT_MS = 60_000;
// How often to re-read CCD's sidebar grouping off disk and upload it if it
// changed. Hash-gated, so an unchanged mirror costs only the local leveldb read.
const MIRROR_SYNC_MS = 20_000;
// Floor between catch-up progress reports. During a long first pass we report
// the bar climbing, but never faster than this — the snapshot is a tiny POST,
// yet there's no point flooding the gateway with sub-second updates. A terminal
// "caught up" snapshot bypasses the floor so the bar always resolves to done.
const SYNC_REPORT_MIN_MS = 1_500;
// Canonical divergence audit cadence: ask the gateway to compare each session's
// canonical size in the store against this device's uploaded offset, and
// re-upload-from-zero whatever drifted (a wiped store, a lost canonical). Runs
// at daemon start and on this timer so a store wipe behind a redeploy heals
// without restarting the daemon.
const VERIFY_INTERVAL_MS = 30 * 60_000;
const VERIFY_BATCH = 1_000;

export interface WatchOptions {
  /** Limit to a single file (debugging). */
  only?: string;
  /** Maximum bytes per chunk. Splits a huge backlog into multiple commits. */
  chunkLimitBytes?: number;
  /** Run once and exit (smoke test). */
  oneShot?: boolean;
}

const DEFAULT_CHUNK_LIMIT = 4 * 1024 * 1024;

// Which state file this config's offsets live in (see StateScope in state.ts).
// The `--local` tee runs the same pipeline against the local dev gateway with
// its own offsets, so the per-gateway latches below are also keyed by scope.
const scopeOf = (cfg: HxConfig): StateScope => cfg.stateScope ?? "main";

// Per-repo route cache, keyed by config scope so the `--local` tee and the main
// lane never share a Fortress token. Lives for the daemon's lifetime; resolveRoute
// refreshes a route before its capability token nears expiry.
const ROUTE_CACHE = new Map<StateScope, Map<string, Route>>();

/** Resolve where this session's repo uploads to, then return the HxConfig the
 *  upload steps should use: the cloud config unchanged, or — for a fortress-direct
 *  route — one pointed at the Fortress gateway with its capability token as the
 *  bearer. Discovery failures fall back to cloud inside resolveRoute (off the hot
 *  path); see route.ts. */
async function uploadConfigFor(
  cfg: HxConfig,
  repoSlug: string | null | undefined,
): Promise<{ cfg: HxConfig; fortress: boolean }> {
  if (!repoSlug || !cfg.accessToken) return { cfg, fortress: false };
  const scope = scopeOf(cfg);
  let cache = ROUTE_CACHE.get(scope);
  if (!cache) {
    cache = new Map<string, Route>();
    ROUTE_CACHE.set(scope, cache);
  }
  const route = await resolveRoute({
    repo: repoSlug,
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    accessToken: cfg.accessToken,
    cache,
  });
  if (route.mode !== "fortress-direct") return { cfg, fortress: false };
  return {
    cfg: { ...cfg, gatewayBaseUrl: route.gatewayUrl, accessToken: route.token },
    fortress: true,
  };
}

// When child-lane uploads are rejected wholesale, pause them for a while
// instead of re-POSTing one doomed request per 1.5s tick. Two known causes:
// 404 — the gateway predates the child-lane endpoints; 401/403 — an auth
// shield in front of the environment (packages/basic-auth-shield) answers
// before route auth, and its bypass list doesn't cover the child/agent
// endpoints, so every child POST bounces while parent uploads keep passing
// (which keeps the pass-level error backoff from ever engaging). Parent
// uploads are deliberately not latched here: a parent-lane 401 means a
// revoked device token and has its own semantics. Keyed per upload lane —
// one gateway rejecting child uploads says nothing about the other.
const CHILD_ENDPOINT_RETRY_MS = 10 * 60_000;
const childEndpointsMissingUntilMs = new Map<StateScope, number>();

/**
 * Latch the child-lane pause when `err` says the lane is rejected wholesale
 * (404 missing endpoints, 401/403 front-door auth shield — see above).
 * Returns true when latched so callers bail out of the rest of the pass.
 */
function latchChildLanePause(
  err: unknown,
  scope: StateScope,
  log: (msg: string) => void,
): boolean {
  if (!(err instanceof HxHttpError)) return false;
  if (err.status !== 404 && err.status !== 401 && err.status !== 403) return false;
  childEndpointsMissingUntilMs.set(scope, Date.now() + CHILD_ENDPOINT_RETRY_MS);
  log(
    err.status === 404
      ? "[hx] gateway has no child-lane endpoints yet; pausing child uploads"
      : `[hx] child-lane uploads rejected (${err.status}); pausing`,
  );
  return true;
}

// Self-heal support is feature-detected once per process PER LANE (absent =
// unknown): the first verify call against a gateway that predates
// sessions/verify 404s, which disables BOTH the audit and the per-commit
// divergence reset for that lane — an old gateway also ignores commit's
// replace flag, so a reset there would re-APPEND the full file onto the bad
// canonical and re-detect the mismatch forever.
const SELF_HEAL = new Map<StateScope, boolean>();

async function readSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Trim a buffer at the last newline so we never split a jsonl line across
 * two chunks. Returns the trimmed buffer + the actual end offset.
 */
function trimAtLastNewline(buf: Buffer, startOffset: number): { trimmed: Buffer; endOffset: number } {
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { trimmed: buf, endOffset: startOffset + buf.length };
  return { trimmed: buf.subarray(0, lastNl + 1), endOffset: startOffset + lastNl + 1 };
}

async function ensureFileState(file: DiscoveredFile, scope: StateScope): Promise<FileState> {
  const existing = await getFileState(file.path, scope);
  if (existing) {
    if (existing.lastMtimeMs !== file.mtimeMs) {
      existing.lastMtimeMs = file.mtimeMs;
      await upsertFileState(existing, scope);
    }
    return existing;
  }
  const head = await readHead(file.path, file.source);
  const seeded: FileState = {
    path: file.path,
    family: head.family,
    sessionId: head.sessionId ?? path.basename(file.path, ".jsonl"),
    offsets: {},
    lastMtimeMs: file.mtimeMs,
    lastUploadAtMs: 0,
  };
  await upsertFileState(seeded, scope);
  return seeded;
}

async function ingestOne(
  cfg: HxConfig,
  file: DiscoveredFile,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<boolean> {
  let st;
  try {
    st = await stat(file.path);
  } catch {
    return false;
  }
  const scope = scopeOf(cfg);
  const fState = await ensureFileState({ ...file, mtimeMs: st.mtimeMs, size: st.size }, scope);
  // Skip only when the file hasn't grown past the LEAST-current destination —
  // a store still behind the others must keep getting bytes.
  const baseOffset = minOffset(fState);
  if (st.size <= baseOffset) {
    if (fState.lastMtimeMs !== st.mtimeMs) {
      await touchMtime(file.path, st.mtimeMs, scope);
    }
    return false;
  }

  // Read the jsonl head up front: the gateway needs repoSlug at append-url time
  // to route this session to the right store (per-session vault attribution),
  // and the commit metadata below reuses the same head.
  const head = await readHead(file.path, file.source);

  // Discover where this repo's sessions upload. A fortress-direct route swaps the
  // base URL + bearer to the org's own Fortress gateway; everything else stays on
  // the cloud. MC-2289 non-goal: NO cloud fallback — if the fortress upload below
  // throws, the chunk stays queued (offset unadvanced) and retries against the
  // Fortress next pass; it is never re-sent to the cloud.
  const route = await uploadConfigFor(cfg, head.repoSlug);
  const uploadCfg = route.cfg;

  // Get signed staging URLs for EVERY store this repo fans out to. repoSlug lets
  // the gateway attribute + resolve the destination set; each is echoed back as
  // its own vaultOrgId so commit replays it into the same store. A gateway that
  // predates fan-out returns a single destination (legacy fields) and planFanout
  // degrades to one step.
  const append = await requestAppendUrl(uploadCfg, {
    family: fState.family as never,
    sessionId: fState.sessionId,
    byteCount: st.size - baseOffset,
    repoSlug: head.repoSlug,
  });
  const steps = planFanout(append, fState);

  // CCD session metadata (title + group id) is byte-independent — resolve once.
  const ccdByCli = await getCcdRecentsByCliId(Date.now()).catch(() => null);
  const ccdMeta = ccdByCli?.get(fState.sessionId) ?? null;

  let anyProgress = false;
  let lastUnavailable: HxHttpError | null = null;
  let artifactText: string | null = null;
  for (const step of steps) {
    // Each destination uploads from its OWN committed offset — a late-joining or
    // previously-offline vault back-fills from zero (replace) while the others
    // append, so one store's lag never blocks another.
    const stepOffset = offsetFor(fState, step.vaultOrgId);
    const want = Math.min(st.size - stepOffset, opts.chunkLimitBytes ?? DEFAULT_CHUNK_LIMIT);
    if (want <= 0) continue;
    const slice = await readSlice(file.path, stepOffset, want);
    const { trimmed, endOffset } = trimAtLastNewline(slice, stepOffset);
    if (trimmed.length === 0) continue;
    const text = trimmed.toString("utf8");
    const summary = summariseChunk(text);
    const title = ccdMeta?.title ?? summary.title ?? head.title ?? undefined;
    let titleSource: "user" | "ai" | "fallback" | undefined;
    if (ccdMeta?.title) titleSource = ccdMeta.titleSource ?? undefined;
    else if (summary.title) titleSource = summary.titleSource ?? undefined;

    try {
      // Upload bytes directly to this destination's store, then compose.
      await putChunk(step.uploadUrl, trimmed);
      const commit = await commitChunk(uploadCfg, {
        family: fState.family as never,
        sessionId: fState.sessionId,
        chunkId: step.chunkId,
        // A from-zero upload REPLACES this store's canonical instead of appending:
        // at offset 0 anything it still holds can't be content this device hasn't
        // sent (stale/duplicated canonical, or a freshly-joined vault). Old
        // gateways ignore the flag and append, same result for a new session.
        replace: step.replace,
        vaultOrgId: step.vaultOrgId,
        meta: {
          sourcePath: file.path,
          title,
          titleSource,
          ccdSessionId: ccdMeta?.ccdSessionId ?? undefined,
          cwd: head.cwd,
          gitBranch: head.gitBranch,
          repoSlug: head.repoSlug,
          entrypoint: head.entrypoint,
          originator: head.originator,
          modelProvider: head.modelProvider,
          lastUserText: summary.lastUserText,
          lastAssistantText: summary.lastAssistantText,
          eventCount: summary.eventCount,
          userTextCount: summary.userTextCount,
          assistantCount: summary.assistantCount,
          lastActivityAt: summary.lastActivityAt,
        },
      });
      // Per-commit divergence check (let.ai-hosted only — the audit + self-heal
      // protocol live there): a size mismatch means the store lost the canonical
      // mid-session; reset just this destination to zero so the next pass
      // re-uploads it with replace. Chunks never split a line, so a healthy
      // canonical matches endOffset byte-for-byte.
      const diverged =
        !route.fortress &&
        SELF_HEAL.get(scope) === true &&
        step.vaultOrgId === null &&
        commit.totalBytes !== endOffset;
      if (diverged) {
        log(
          `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${commit.totalBytes}B ≠ uploaded ${endOffset}B — re-uploading from zero`,
        );
        await setOffsetFor(file.path, step.vaultOrgId, 0, st.mtimeMs, scope);
      } else {
        await setOffsetFor(file.path, step.vaultOrgId, endOffset, st.mtimeMs, scope);
      }
      // Sidecars (tasks/plan) are whole-file + hash-gated and route server-side
      // to the session's store, so one sync off any destination's new tail is
      // enough — capture the first.
      if (artifactText === null) artifactText = text;
      anyProgress = true;
      log(
        `  ${path.relative(process.env.HOME ?? "", file.path)} (+${trimmed.length}B → ${step.vaultOrgId ?? "let.ai"}, ${fState.family}, ${fState.sessionId.slice(0, 8)}…)`,
      );
    } catch (err) {
      // One destination's vault being unavailable must not stall the others — log
      // and move on; its offset stays put so the next pass retries just it.
      if (err instanceof HxHttpError && err.serverUnavailable) {
        lastUnavailable = err;
        log(
          `  [hx] destination ${step.vaultOrgId ?? "let.ai"} unavailable (${err.status}); will retry`,
        );
        continue;
      }
      throw err;
    }
  }

  // Nothing landed: if a vault was unavailable, surface it so the pass-level
  // backoff in tickOnce kicks in (don't hammer it every poll). Otherwise there
  // were simply no new committable bytes for any destination this pass.
  if (!anyProgress) {
    if (lastUnavailable) throw lastUnavailable;
    return false;
  }

  // Best-effort sidecar sync — a failure must never fail the transcript.
  if (artifactText !== null) {
    await syncArtifacts(cfg, fState, artifactText, log).catch((err) => {
      log(`  [artifacts] ${fState.sessionId.slice(0, 8)}…: ${(err as Error).message}`);
    });
  }
  return true;
}

/**
 * Upload fresh bytes for one child-lane transcript (a subagent's or a workflow
 * agent's jsonl). Same offset-tail + chunk pipeline as the parent, against the
 * dedicated agent endpoints; per-file state reuses the same FileState map
 * (keyed by path), with sessionId = the PARENT session id.
 */
async function ingestChildOne(
  cfg: HxConfig,
  child: DiscoveredChildFile,
  familyBySession: Map<string, string>,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<boolean> {
  let st;
  try {
    st = await stat(child.path);
  } catch {
    return false;
  }
  const scope = scopeOf(cfg);
  let fState = await getFileState(child.path, scope);
  if (!fState) {
    fState = {
      path: child.path,
      // The child belongs to the parent's session row, so it MUST upload under
      // the parent's family or the gateway would mint a sibling row id.
      family: familyBySession.get(child.parentSessionId) ?? "claude-cli",
      sessionId: child.parentSessionId,
      offsets: {},
      lastMtimeMs: st.mtimeMs,
      lastUploadAtMs: 0,
    };
    await upsertFileState(fState, scope);
  }
  // A child lane is single-destination (its store is the parent session's,
  // resolved server-side and stable), so its one offset is the min over keys.
  const childOffset = minOffset(fState);
  if (st.size <= childOffset) {
    if (fState.lastMtimeMs !== st.mtimeMs) {
      await touchMtime(child.path, st.mtimeMs, scope);
    }
    return false;
  }

  const want = Math.min(st.size - childOffset, opts.chunkLimitBytes ?? DEFAULT_CHUNK_LIMIT);
  const slice = await readSlice(child.path, childOffset, want);
  const { trimmed, endOffset } = trimAtLastNewline(slice, childOffset);
  if (trimmed.length === 0) return false;
  // From-zero first chunk replaces the child canonical (divergence repair,
  // mirroring the parent path). The agent endpoints always understand it.
  const replace = childOffset === 0;

  const append = await requestAgentAppendUrl(cfg, {
    family: fState.family as never,
    sessionId: fState.sessionId,
    agentId: child.agentId,
    byteCount: trimmed.length,
  });
  await putChunk(append.uploadUrl, trimmed);

  const text = trimmed.toString("utf8");
  const summary = summariseChunk(text);
  const meta = await readAgentMeta(child.metaPath);
  // cwd/gitBranch ride on every child line; the head reader extracts them.
  const head = await readHead(child.path, "claude");
  const kind: "subagent" | "workflow_agent" =
    child.runId || meta?.agentType === "workflow-subagent" ? "workflow_agent" : "subagent";

  await commitAgentChunk(cfg, {
    family: fState.family as never,
    sessionId: fState.sessionId,
    agentId: child.agentId,
    chunkId: append.chunkId,
    replace,
    vaultOrgId: append.vaultOrgId,
    meta: {
      kind,
      runId: child.runId,
      toolUseId: meta?.toolUseId,
      agentType: meta?.agentType,
      label: meta?.description,
      worktreePath: meta?.worktreePath,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      eventCount: summary.eventCount,
      lastActivityAt: summary.lastActivityAt,
    },
  });

  await setOffsetFor(child.path, append.vaultOrgId ?? null, endOffset, st.mtimeMs, scope);
  log(
    `  [agent] ${fState.sessionId.slice(0, 8)}…/${child.agentId.slice(0, 8)}… (+${trimmed.length}B${child.runId ? `, ${child.runId}` : ""})`,
  );
  return true;
}

/**
 * Upload a workflow run's sidecar (script + journal) when either changed.
 * Whole small files, hash-gated like tasks/plan. The journal is what gives the
 * viewer authoritative per-agent status, so it syncs on every tick that moves.
 */
async function syncWorkflowRun(
  cfg: HxConfig,
  run: DiscoveredWorkflowRun,
  familyBySession: Map<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  const family = (familyBySession.get(run.parentSessionId) ?? "claude-cli") as never;
  const journal = await readTextFile(run.journalPath);
  const script = await readTextFile(run.scriptPath);
  if (!journal && !script) return;
  const key = `${String(family)}:${run.parentSessionId}:wf:${run.runId}`;
  const hash = hashContent(`${script ?? ""}\n--journal--\n${journal ?? ""}`);
  if ((await getArtifactHash(key, scope)) === hash) return;
  await uploadWorkflowRun(cfg, {
    family,
    sessionId: run.parentSessionId,
    runId: run.runId,
    scriptName: run.scriptName,
    script,
    journal,
  });
  await setArtifactHash(key, hash, scope);
  log(`  [workflow] ${run.parentSessionId.slice(0, 8)}…/${run.runId}`);
}

// Mirror the device's active agent teams (~/.claude/teams/*). The dirs exist
// only while a team runs; an upload happens only when the set changes, and the
// transition back to "no teams" uploads once (clearing the server mirror).
async function syncTeamMirror(cfg: HxConfig, log: (msg: string) => void): Promise<void> {
  const scope = scopeOf(cfg);
  let teams;
  try {
    teams = await readTeamConfigs();
  } catch {
    return;
  }
  const hash = hashContent(JSON.stringify(teams.map((t) => [t.name, t.config])));
  const key = "teams:mirror";
  if ((await getArtifactHash(key, scope)) === hash) return;
  try {
    await uploadTeamMirror(cfg, { teams, syncedAtMs: Date.now() });
    await setArtifactHash(key, hash, scope);
    if (teams.length > 0) log(`  [teams] synced ${teams.length} team(s)`);
  } catch (err) {
    log(`  [teams] sync failed: ${(err as Error).message}`);
  }
}

/**
 * After a session's transcript chunk lands, sync its sidecar artifacts:
 *   • tasks — the whole ~/.claude/tasks/<sessionId>/ set, if any
 *   • plan  — only when this fresh chunk introduced a plan_mode attachment
 * Both are content-hash-gated so an unchanged file never re-uploads.
 */
async function syncArtifacts(
  cfg: HxConfig,
  fState: FileState,
  chunkText: string,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  const tasks = await readTaskSet(fState.sessionId);
  if (tasks && tasks.length > 0) {
    const key = `${fState.family}:${fState.sessionId}:tasks`;
    const hash = hashContent(JSON.stringify(tasks));
    if ((await getArtifactHash(key, scope)) !== hash) {
      await uploadTasks(cfg, {
        family: fState.family as never,
        sessionId: fState.sessionId,
        tasks,
      });
      await setArtifactHash(key, hash, scope);
      log(`  [tasks] ${fState.sessionId.slice(0, 8)}… (${tasks.length})`);
    }
  }

  const planPath = findPlanPathInText(chunkText);
  if (planPath) {
    const plan = await readPlanFile(planPath);
    if (plan) {
      const key = `${fState.family}:${fState.sessionId}:plan`;
      const hash = hashContent(plan.content);
      if ((await getArtifactHash(key, scope)) !== hash) {
        await uploadPlan(cfg, {
          family: fState.family as never,
          sessionId: fState.sessionId,
          planFilePath: plan.planFilePath,
          content: plan.content,
        });
        await setArtifactHash(key, hash, scope);
        log(`  [plan] ${fState.sessionId.slice(0, 8)}…`);
      }
    }
  }
}

/**
 * One-time catch-up: upload tasks (+ plans) for every ~/.claude/tasks/<id>/
 * dir already on disk, regardless of whether the transcript grew recently.
 * `hx watch` only syncs artifacts off a fresh transcript chunk, so historical
 * sessions need this. Hash-gated, so re-running it is cheap.
 */
export async function backfillArtifacts(
  cfg: HxConfig,
  log: (msg: string) => void,
): Promise<{ tasks: number; plans: number; failed: number }> {
  const sessionIds = await listTaskSessionIds();
  if (sessionIds.length === 0) {
    log("[hx] no ~/.claude/tasks dirs to backfill");
    return { tasks: 0, plans: 0, failed: 0 };
  }
  // Map sessionId → { family, jsonl path } from discovered Claude logs so we
  // stamp the right family and can find each session's plan attachment.
  const claude = await discoverClaudeFiles();
  const byId = new Map<string, { family: string; path: string }>();
  for (const f of claude) {
    const head = await readHead(f.path, f.source);
    const sid = head.sessionId ?? path.basename(f.path, ".jsonl");
    if (!byId.has(sid)) byId.set(sid, { family: head.family, path: f.path });
  }
  let tasksN = 0;
  let plansN = 0;
  let failed = 0;
  for (const sid of sessionIds) {
    const info = byId.get(sid);
    const family = (info?.family ?? "claude-cli") as never;
    try {
      const tasks = await readTaskSet(sid);
      if (tasks && tasks.length > 0) {
        await uploadTasks(cfg, { family, sessionId: sid, tasks });
        await setArtifactHash(`${info?.family ?? "claude-cli"}:${sid}:tasks`, hashContent(JSON.stringify(tasks)), scopeOf(cfg));
        tasksN += 1;
        log(`  [tasks] ${sid.slice(0, 8)}… (${tasks.length})`);
      }
    } catch (err) {
      failed += 1;
      log(`  [error] tasks ${sid.slice(0, 8)}: ${(err as Error).message}`);
    }
    if (info) {
      try {
        const plan = await readPlanForJsonl(info.path);
        if (plan) {
          await uploadPlan(cfg, { family, sessionId: sid, planFilePath: plan.planFilePath, content: plan.content });
          await setArtifactHash(`${info.family}:${sid}:plan`, hashContent(plan.content), scopeOf(cfg));
          plansN += 1;
          log(`  [plan] ${sid.slice(0, 8)}…`);
        }
      } catch (err) {
        failed += 1;
        log(`  [error] plan ${sid.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
  }
  log(`[hx] backfill done: ${tasksN} task sets, ${plansN} plans (${failed} failed)`);
  return { tasks: tasksN, plans: plansN, failed };
}

// Read CCD's sidebar grouping off the local leveldb and upload it if it
// changed since the last sync. Hash-gated on the meaningful content (groups +
// enabled + unread), so an unchanged mirror never re-uploads. Best-effort: a
// failure here never affects transcript uploads.
async function syncGroupMirror(cfg: HxConfig, log: (msg: string) => void): Promise<void> {
  const scope = scopeOf(cfg);
  let mirror;
  try {
    mirror = await buildGroupMirror(Date.now());
  } catch {
    return;
  }
  // Exclude the volatile syncedAtMs from the gate — only content changes count.
  const hash = hashContent(
    JSON.stringify({
      enabled: mirror.groupingEnabled,
      groups: mirror.groups,
      unread: [...mirror.unreadIds].sort(),
    }),
  );
  const key = "ccd:group-mirror";
  if ((await getArtifactHash(key, scope)) === hash) return;
  try {
    const res = await uploadGroupMirror(cfg, mirror);
    await setArtifactHash(key, hash, scope);
    log(`  [groups] synced ${res.groups} CCD group(s)`);
  } catch (err) {
    log(`  [groups] sync failed: ${(err as Error).message}`);
  }
}

/**
 * Canonical divergence audit. For every file this device has uploaded bytes
 * for, ask the gateway whether the canonical object in the store actually
 * holds that many bytes. Whatever drifted — a deploy wiped the store, a
 * canonical got mangled — has its offset reset to zero, so the next pass
 * re-uploads the whole file with replace:true and the server copy converges
 * back to the device's source of truth. Runs between upload passes, never
 * concurrently with one, so an in-flight chunk can't read as divergence.
 */
async function auditCanonicals(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  if (SELF_HEAL.get(scope) === false) return;
  const [claude, codex] = await Promise.all([discoverClaudeFiles(), discoverCodexFiles()]);
  let files = [...claude, ...codex];
  if (opts.only) files = files.filter((f) => f.path === opts.only);
  const state = await loadState(scope);
  const candidates: Array<{ path: string; fState: FileState }> = [];
  for (const f of files) {
    const fs = state.files[f.path];
    // offset 0 needs no audit — it re-uploads (with replace) regardless. The
    // audit only repairs let.ai-hosted canonical wipes (ephemeral-FS redeploys);
    // customer vault stores are durable and aren't subject to them, so we audit
    // only the let.ai destination's offset — matching the server, which skips
    // vault-routed sessions. A late-joining/offline vault catches up via its own
    // per-destination offset (0 → replace), needing no audit.
    if (fs && offsetFor(fs, null) > 0) candidates.push({ path: f.path, fState: fs });
  }
  if (candidates.length === 0) return;

  let healed = 0;
  for (let i = 0; i < candidates.length; i += VERIFY_BATCH) {
    const batch = candidates.slice(i, i + VERIFY_BATCH);
    let results;
    try {
      results = await verifySessions(
        cfg,
        batch.map(({ fState }) => ({
          family: fState.family as never,
          sessionId: fState.sessionId,
          byteCount: offsetFor(fState, null),
        })),
      );
    } catch (err) {
      if (err instanceof HxHttpError && err.status === 404) {
        // Gateway predates sessions/verify (and commit's replace flag) —
        // disable self-heal for this lane rather than thrash.
        SELF_HEAL.set(scope, false);
        log(`[hx] gateway has no sessions/verify; canonical self-heal disabled`);
        return;
      }
      throw err;
    }
    SELF_HEAL.set(scope, true);
    const byKey = new Map(results.map((r) => [`${r.family}:${r.sessionId}`, r]));
    for (const { path: filePath, fState } of batch) {
      const r = byKey.get(`${fState.family}:${fState.sessionId}`);
      if (r?.status !== "divergent") continue;
      healed += 1;
      // Log before the reset — setOffsetFor mutates this same fState object.
      log(
        `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${r.storeBytes ?? 0}B ≠ uploaded ${offsetFor(fState, null)}B — re-uploading from zero`,
      );
      await setOffsetFor(filePath, null, 0, fState.lastMtimeMs, scope);
    }
  }
  if (healed > 0) log(`[hx] canonical audit: re-uploading ${healed} diverged session(s)`);
}

/**
 * Catch-up snapshot from the discovered files + the persisted upload offsets:
 * a file is "done" once we've uploaded up to its (discovery-time) size, and
 * every file short of that contributes its remaining bytes to the backlog.
 * Pure in-memory — `state` is the cached object the upload path mutates, so a
 * recompute mid-pass reflects offsets bumped by commits earlier in the pass.
 */
function snapshotFrom(files: DiscoveredFile[], state: HxState): SyncSnapshot {
  let done = 0;
  let totalBytes = 0;
  for (const f of files) {
    const fs = state.files[f.path];
    // "Done" = the least-current destination has caught up to the file size.
    const offset = fs ? minOffset(fs) : 0;
    if (offset >= f.size) done += 1;
    totalBytes += f.size; // total size of ALL sessions, synced or not
  }
  return { total: files.length, done, totalBytes };
}

// Report progress at most every Nth file so a long first pass shows the bar
// climbing without a callback per file. Start + end are always reported.
const SYNC_PROGRESS_EVERY = 20;

/** One-shot catch-up snapshot (no upload) — backs `hx status` and the daemon
 *  restart decision. Main lane only: the `--local` tee tracks its own catch-up
 *  through its own tick's onProgress reports. */
export async function computeSyncSnapshot(only?: string): Promise<SyncSnapshot> {
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(),
    discoverCodexFiles(),
  ]);
  let files = [...claude, ...codex];
  if (only) files = files.filter((f) => f.path === only);
  const state = await loadState();
  return snapshotFrom(files, state);
}

export async function tickOnce(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
  onProgress?: (snap: SyncSnapshot) => void,
): Promise<{ uploaded: number; failed: number; snapshot: SyncSnapshot }> {
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(),
    discoverCodexFiles(),
  ]);
  let files = [...claude, ...codex];
  if (opts.only) files = files.filter((f) => f.path === opts.only);

  const scope = scopeOf(cfg);
  // Report before uploading anything so a freshly connected device shows its
  // full backlog ("0 / 1,203") immediately, not only after the first pass.
  const state = await loadState(scope);
  onProgress?.(snapshotFrom(files, state));

  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    try {
      const did = await ingestOne(cfg, f, opts, log);
      if (did) uploaded += 1;
    } catch (err) {
      failed += 1;
      log(`  [error] ${f.path}: ${(err as Error).message}`);
      if (err instanceof HxHttpError && err.serverUnavailable) {
        // The gateway/storage is refusing uploads wholesale — don't keep
        // POSTing the rest of this pass's backlog at it. The watcher backs off
        // before the next pass; bail out of this one now.
        log(`  [hx] gateway unavailable (${err.status}); pausing this pass`);
        break;
      }
    }
    if (onProgress && (i + 1) % SYNC_PROGRESS_EVERY === 0) {
      onProgress(snapshotFrom(files, state));
    }
  }

  // Child lanes + workflow sidecars (Claude only; Codex has no equivalent).
  // Runs after the parent pass so a brand-new session's parent commit lands
  // first — that row is what the gateway resolves child vault routing from.
  // Children are excluded from the sync snapshot on purpose: the Devices bar
  // counts sessions, and a child stream is part of its session, not a new one.
  if (!opts.only && Date.now() >= (childEndpointsMissingUntilMs.get(scope) ?? 0)) {
    const familyBySession = new Map<string, string>();
    for (const f of Object.values(state.files)) {
      familyBySession.set(f.sessionId, f.family);
    }
    try {
      const { children, runs } = await discoverClaudeChildren();
      for (const c of children) {
        try {
          const did = await ingestChildOne(cfg, c, familyBySession, opts, log);
          if (did) uploaded += 1;
        } catch (err) {
          failed += 1;
          log(`  [error] ${c.path}: ${(err as Error).message}`);
          if (latchChildLanePause(err, scope, log)) break;
          if (err instanceof HxHttpError && err.serverUnavailable) break;
        }
      }
      for (const r of runs) {
        try {
          await syncWorkflowRun(cfg, r, familyBySession, log);
        } catch (err) {
          if (latchChildLanePause(err, scope, log)) break;
          log(`  [error] workflow ${r.runId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log(`[hx] child discovery error: ${(err as Error).message}`);
    }
  }

  const snapshot = snapshotFrom(files, state);
  onProgress?.(snapshot);
  return { uploaded, failed, snapshot };
}

export async function startWatch(
  cfg: HxConfig,
  opts: WatchOptions,
  log: (msg: string) => void,
): Promise<{ stop: () => void }> {
  log(
    `[hx] watching ${CLAUDE_PROJECTS_DIR}, ${CODEX_SESSIONS_DIR}, ${CODEX_ARCHIVED_DIR}`,
  );
  log(`[hx] poll interval ${FAST_POLL_MS}ms; gateway ${cfg.gatewayBaseUrl}`);

  // Last time anything reached the gateway (upload or beat). Uploads count as
  // contact, so a busy daemon never sends a redundant heartbeat.
  let lastContactMs = 0;

  // Upload backoff: when a pass makes zero progress and hits errors (the gateway
  // is refusing uploads), skip upload passes until `pauseUploadsUntilMs`, growing
  // the window exponentially. Any pass that isn't a stalled-with-errors one
  // resets it back to the normal FAST_POLL_MS cadence.
  let uploadBackoffMs = 0;
  let pauseUploadsUntilMs = 0;

  // Catch-up progress reporting. We POST a snapshot only when the picture
  // changed since the last one we sent, throttled to SYNC_REPORT_MIN_MS — except
  // a terminal "caught up" snapshot, which always goes through so the bar
  // resolves to done. A successful report also counts as contact (it carries a
  // bearer token), so it refreshes liveness like an upload.
  let lastSyncSig = "";
  let lastSyncSentMs = 0;
  const reportSync = (snap: SyncSnapshot): void => {
    const sig = `${snap.done}/${snap.total}/${snap.totalBytes}`;
    if (sig === lastSyncSig) return;
    const caughtUp = snap.total > 0 && snap.done >= snap.total;
    const nowMs = Date.now();
    if (!caughtUp && nowMs - lastSyncSentMs < SYNC_REPORT_MIN_MS) return;
    lastSyncSig = sig;
    lastSyncSentMs = nowMs;
    void sendSyncStatus(cfg, snap)
      .then(() => {
        lastContactMs = Date.now();
      })
      .catch((err) => log(`[hx] sync-status error: ${(err as Error).message}`));
  };

  // One pass at a time: upload ticks and the canonical audit both walk the
  // offset state, and an audit overlapping a live pass would read a chunk in
  // flight as divergence. A skipped tick is re-covered 1.5s later; a skipped
  // audit by its next interval.
  let passBusy = false;

  const run = async () => {
    if (Date.now() < pauseUploadsUntilMs) return;
    if (passBusy) return;
    passBusy = true;
    try {
      const { uploaded, failed } = await tickOnce(cfg, opts, log, reportSync);
      if (uploaded || failed) {
        if (uploaded) lastContactMs = Date.now();
        log(`[hx] tick uploaded=${uploaded} failed=${failed}`);
      }
      if (uploaded === 0 && failed > 0) {
        uploadBackoffMs = uploadBackoffMs
          ? Math.min(UPLOAD_BACKOFF_MAX_MS, uploadBackoffMs * 2)
          : UPLOAD_BACKOFF_BASE_MS;
        pauseUploadsUntilMs = Date.now() + uploadBackoffMs;
        log(`[hx] uploads not progressing; backing off ${Math.round(uploadBackoffMs / 1000)}s`);
      } else if (uploadBackoffMs > 0) {
        uploadBackoffMs = 0;
        pauseUploadsUntilMs = 0;
        log(`[hx] uploads recovered; resuming normal cadence`);
      }
    } catch (err) {
      log(`[hx] tick error: ${(err as Error).message}`);
    } finally {
      passBusy = false;
    }
  };

  const beat = async () => {
    if (Date.now() - lastContactMs < HEARTBEAT_MS) return;
    try {
      await sendHeartbeat(cfg);
      lastContactMs = Date.now();
    } catch (err) {
      log(`[hx] heartbeat error: ${(err as Error).message}`);
    }
  };

  // Audit before the first pass so diverged sessions re-upload during the
  // initial catch-up instead of waiting half an hour. Best-effort: a gateway
  // that's down (or predates verify) must not stall the watcher.
  const audit = async (): Promise<void> => {
    if (passBusy) return; // a pass is mid-flight; the next interval retries
    passBusy = true;
    try {
      await auditCanonicals(cfg, opts, log);
    } catch (err) {
      log(`[hx] canonical audit error: ${(err as Error).message}`);
    } finally {
      passBusy = false;
    }
  };
  await audit();
  await run();
  await beat(); // announce liveness immediately so a fresh daemon reads "live"
  await syncGroupMirror(cfg, log); // push CCD's grouping on start
  await syncTeamMirror(cfg, log); // push active agent teams on start
  if (opts.oneShot) return { stop: () => {} };
  const timer = setInterval(() => void run(), FAST_POLL_MS);
  const hbTimer = setInterval(() => void beat(), HEARTBEAT_MS);
  const mirrorTimer = setInterval(() => {
    void syncGroupMirror(cfg, log);
    void syncTeamMirror(cfg, log);
  }, MIRROR_SYNC_MS);
  const auditTimer = setInterval(() => void audit(), VERIFY_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      clearInterval(hbTimer);
      clearInterval(mirrorTimer);
      clearInterval(auditTimer);
    },
  };
}
