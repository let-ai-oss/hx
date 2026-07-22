// mtime-poll watcher.
//
// Strategy: poll the candidate directories at ~1.5s intervals, walk the cache
// of per-file mtimes, and trigger an upload when (mtime, size) move. fs.watch +
// chokidar were considered and rejected — too many directories, FD pressure
// under `~/.claude/projects/<encoded-path>/...`.
//
// Per-file upload pipeline:
//   1. read bytes from `state.offset → EOF`
//   2. request signed PUT URL
//   3. PUT bytes
//   4. POST commit (gateway composes into canonical)
//   5. bump state.offset

import { existsSync } from "node:fs";
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
  type FileSkipReason,
  type FileState,
  type HxState,
  type SyncBlockerDetails,
  type StateScope,
  clearFileFailure,
  clearHeal,
  destKey,
  getArtifactHash,
  getFileState,
  loadState,
  recordFileFailure,
  minOffset,
  offsetFor,
  recordHeal,
  reconcileDestinations,
  setArtifactHash,
  setOffsetFor,
  touchMtime,
  upsertFileState,
} from "./state.js";
import { planFanout } from "./fanout.js";
import { collapseHome, isPaused, readSettings, shouldSkipFile, type HxSettings } from "./settings.js";
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
  vaultBlockerFromDestinations,
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
// Per-FILE retry pacing (state.ts recordFileFailure doubles these per failure,
// capped at 30 min): an ordinary per-request fault backs off from 30 s.
const FILE_RETRY_BASE_MS = 30_000;
// A session whose OWN store is temporarily unavailable (its vault is offline, or
// a store it routes to directly is down) is skipped — the rest keep uploading.
// Start short so a brief blip (a redeploy, a flaky link) is retried within
// seconds; consecutive failures then double the wait toward the 30-min cap, so a
// genuine outage stops burning round trips. This is the "a few quick retries,
// then back off" the skip path wants, using the existing exponential.
const SESSION_SKIP_RETRY_BASE_MS = 20_000;
// How many chunk rounds ONE file may drain within a single pass (x 4 MB chunk
// limit = up to 64 MB per destination per pass). Enough that a big backlog
// moves at line speed, capped so one huge file can't starve the rest.
const DRAIN_ROUNDS_PER_PASS = 16;
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

/**
 * A session's OWN destination store is temporarily unavailable — its vault is
 * offline, or a store it routes to directly is down. Distinct from the shared
 * cloud gateway being down: the watcher skips just this file (short retries,
 * then a longer backoff) and keeps uploading every other session, instead of
 * pausing the whole pass. Thrown by `ingestOne`, handled in `tickOnce`.
 */
export class SessionUpstreamUnavailable extends Error {
  constructor(
    readonly reason: FileSkipReason,
    /** HTTP status when the store answered; null for an outright network failure. */
    readonly status: number | null,
    cause: unknown,
    readonly blocker?: SyncBlockerDetails,
  ) {
    super(`session store unavailable (${reason})`, { cause });
    this.name = "SessionUpstreamUnavailable";
  }
}

/**
 * Decide whether `err` means THIS session's destination store is temporarily
 * unavailable — a transient outage to skip past, not a shared-gateway failure
 * and not this file's own fault. Returns a wrapped error to throw, or null to
 * let the caller handle `err` unchanged.
 *
 * `fortress` = the session uploads straight to its org's own store. A 5xx or an
 * outright network failure there is that one store being down. On the shared
 * cloud gateway the same 5xx could be a wholesale outage affecting every
 * session, so there only an explicit `vault_offline` (the gateway naming the
 * session's vault) is treated as per-session; a bare 5xx falls through to the
 * pass-level pause. A 4xx is never "unavailable" — it's a genuine per-file fault.
 */
export function classifyUpstreamError(
  err: unknown,
  fortress: boolean,
): SessionUpstreamUnavailable | null {
  if (err instanceof HxHttpError) {
    if (err.vaultOffline) {
      return new SessionUpstreamUnavailable("vault_offline", err.status, err, err.blocker);
    }
    if (fortress && err.serverUnavailable) {
      return new SessionUpstreamUnavailable("store_unreachable", err.status, err);
    }
    return null;
  }
  // A non-HTTP throw (DNS failure, connection refused/reset, timeout) against a
  // direct store route is that store being unreachable. On the cloud gateway the
  // same symptom could be local connectivity affecting every session, so it is
  // left to the generic per-file backoff rather than singled out here.
  if (fortress && err instanceof Error) {
    return new SessionUpstreamUnavailable("store_unreachable", null, err);
  }
  return null;
}

/** Human-readable form of a skip reason for the daemon log. */
function describeSkip(reason: FileSkipReason): string {
  return reason === "vault_offline"
    ? "session vault temporarily unavailable"
    : "session store unreachable";
}

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
    // Legacy entries predate the cwd/repoSlug columns the settings filters
    // match on — re-seed them once from the head so exclusions apply.
    if (existing.cwd === undefined) {
      const head = await readHead(file.path, file.source);
      existing.cwd = head.cwd ? collapseHome(head.cwd) : path.dirname(file.path);
      existing.repoSlug = head.repoSlug;
      await upsertFileState(existing, scope);
    }
    if (existing.lastMtimeMs !== file.mtimeMs || existing.lastKnownSize !== file.size) {
      existing.lastMtimeMs = file.mtimeMs;
      existing.lastKnownSize = file.size;
      await upsertFileState(existing, scope);
    }
    return existing;
  }
  const head = await readHead(file.path, file.source);
  const seeded: FileState = {
    path: file.path,
    family: head.family,
    sessionId: head.sessionId ?? path.basename(file.path, ".jsonl"),
    cwd: head.cwd ? collapseHome(head.cwd) : path.dirname(file.path),
    repoSlug: head.repoSlug,
    offsets: {},
    lastKnownSize: file.size,
    lastMtimeMs: file.mtimeMs,
    lastUploadAtMs: 0,
  };
  await upsertFileState(seeded, scope);
  return seeded;
}

/**
 * Drop files the device's settings keep local (excluded folders, path rules,
 * personal gate). Matching happens on the persisted state identity; a file
 * with no state entry yet passes — its first ingest seeds the entry and the
 * pre-upload check in tickOnce keeps its bytes on the machine.
 */
export function filterWatched(
  files: DiscoveredFile[],
  state: HxState,
  settings: HxSettings,
): DiscoveredFile[] {
  return files.filter((f) => {
    const fs = state.files[f.path];
    if (!fs) return true;
    return !shouldSkipFile(settings, fs);
  });
}

const FALLBACK_TITLE_MAX = 80;

/** First line of `text`, whitespace-collapsed and word-boundary truncated with
 *  an ellipsis. Null when there is nothing legible. */
function firstLineLabel(text: string | null): string | null {
  if (!text) return null;
  const oneLine = (text.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
  if (!oneLine) return null;
  if (oneLine.length <= FALLBACK_TITLE_MAX) return oneLine;
  const clipped = oneLine.slice(0, FALLBACK_TITLE_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const base = lastSpace >= FALLBACK_TITLE_MAX * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.replace(/[\s.,;:!?—-]+$/, "")}…`;
}

/** A readable label for a session that carries no user/AI title of its own: the
 *  opening user message, else the repo or working-directory name. Returns null
 *  when even those are unavailable, so the caller leaves the title unset. */
function deriveFallbackTitle(
  firstUserText: string | null,
  cwd: string | null,
  repoSlug: string | null,
): string | null {
  const fromMessage = firstLineLabel(firstUserText);
  if (fromMessage) return fromMessage;
  const repo = repoSlug?.split("/").pop()?.trim();
  if (repo) return repo;
  const base = cwd
    ?.split(/[/\\]+/)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop()
    ?.trim();
  return base && base.length > 0 ? base : null;
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
  // A held session must re-resolve its destination even when every previously
  // known offset is caught up: the missing/held store may not have had an
  // offset key on an older gateway response, and remediation may have moved
  // the repo to a different destination.
  if (st.size <= baseOffset && !fState.skipReason) {
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
  // the cloud. Non-goal: NO cloud fallback — if the fortress upload below
  // throws, the chunk stays queued (offset unadvanced) and retries against the
  // Fortress next pass; it is never re-sent to the cloud.
  const route = await uploadConfigFor(cfg, head.repoSlug);
  const uploadCfg = route.cfg;

  // CCD session metadata (title + group id) is byte-independent — resolve once.
  const ccdByCli = await getCcdRecentsByCliId(Date.now()).catch(() => null);
  const ccdMeta = ccdByCli?.get(fState.sessionId) ?? null;

  let anyProgress = false;
  let lastUnavailable: HxHttpError | null = null;
  let heldBlocker: SyncBlockerDetails | undefined;
  let artifactText: string | null = null;
  // A destination that answered "unavailable" this pass is skipped for the
  // rest of the pass — its offset stays put and the next pass retries it.
  const unavailableDests = new Set<string>();

  // Drain rounds: a backlogged file uploads chunk after chunk within ONE pass
  // (fresh signed URLs each round) instead of one chunk per 1.5 s poll — the
  // old pacing capped any session at ~2.7 MB/s regardless of bandwidth. The
  // per-pass cap keeps one huge file from starving the rest of the backlog;
  // whatever is left continues next pass.
  //
  // Wrap the whole drain: any error that means THIS session's store is
  // unavailable (a direct-route store's 5xx/network failure, or the gateway's
  // vault_offline) is re-thrown as SessionUpstreamUnavailable so tickOnce skips
  // just this file and keeps the pass going. Everything else propagates as-is.
  try {
  for (let round = 0; round < DRAIN_ROUNDS_PER_PASS; round++) {
    // Get signed staging URLs for EVERY store this repo fans out to. repoSlug lets
    // the gateway attribute + resolve the destination set; each is echoed back as
    // its own vaultOrgId so commit replays it into the same store. A gateway that
    // predates fan-out returns a single destination (legacy fields) and planFanout
    // degrades to one step.
    const append = await requestAppendUrl(uploadCfg, {
      family: fState.family as never,
      sessionId: fState.sessionId,
      byteCount: st.size - minOffset(fState),
      repoSlug: head.repoSlug,
    });

    heldBlocker = vaultBlockerFromDestinations(append.destinations);

    // The destinations array is the gateway's current truth for this session's
    // fan-out set (ready AND held). Drop offsets for destinations that left the
    // set entirely — a stale key pins minOffset (and the sync bar) forever.
    // Legacy single-destination responses are left alone: an old gateway can't
    // enumerate the set, so pruning against it could drop a live vault's offset.
    if (append.destinations) {
      await reconcileDestinations(
        file.path,
        append.destinations.map((d) => destKey(d.vaultOrgId)),
        scope,
      );
    }

    const steps = planFanout(append, fState).filter(
      (step) => !unavailableDests.has(destKey(step.vaultOrgId)),
    );

    let roundProgress = false;
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
      let title = ccdMeta?.title ?? summary.title ?? head.title ?? undefined;
      let titleSource: "user" | "ai" | "fallback" | undefined;
      if (ccdMeta?.title) titleSource = ccdMeta.titleSource ?? undefined;
      else if (summary.title) titleSource = summary.titleSource ?? undefined;
      else if (head.title) titleSource = "ai";
      // No user/AI title anywhere — synthesize a readable label so the session
      // shows something meaningful instead of a bare id downstream. Only on a
      // from-zero upload: a later appended chunk must not overwrite it with a
      // mid-conversation message. Stamped "fallback" so the provenance stays
      // honest.
      if (!title && stepOffset === 0) {
        const derived = deriveFallbackTitle(summary.firstUserText, head.cwd, head.repoSlug);
        if (derived) {
          title = derived;
          titleSource = "fallback";
        }
      }

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
        if (diverged && (fState.healPausedUntilMs ?? 0) > Date.now()) {
          // Heal is paused (a prior streak ping-ponged) — accept our own offset
          // so the file stops re-uploading; the periodic audit keeps reporting
          // the divergence and healing resumes when the pause lapses.
          await setOffsetFor(file.path, step.vaultOrgId, endOffset, st.mtimeMs, scope);
        } else if (diverged) {
          const streak = await recordHeal(file.path, scope);
          log(
            `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${commit.totalBytes}B ≠ uploaded ${endOffset}B — re-uploading from zero`,
          );
          if ((fState.healPausedUntilMs ?? 0) > Date.now()) {
            log(
              `  [heal] ${fState.sessionId.slice(0, 8)}… diverged ${streak}x in a row — pausing self-heal for this file`,
            );
          }
          await setOffsetFor(file.path, step.vaultOrgId, 0, st.mtimeMs, scope);
        } else {
          await setOffsetFor(file.path, step.vaultOrgId, endOffset, st.mtimeMs, scope);
          // Only a clean APPEND (stepOffset > 0) ends a heal streak. The
          // from-zero re-upload a heal triggers is ALSO clean by construction
          // (we resend the whole file, so totalBytes == endOffset) — clearing
          // on it would reset the counter every heal and the ping-pong latch
          // could never reach its threshold. A clean append means the store
          // accepted our tail without diverging: genuinely healthy.
          if (stepOffset > 0 && fState.healCount !== undefined) {
            await clearHeal(file.path, scope);
          }
        }
        // Sidecars (tasks/plan) are whole-file + hash-gated and route server-side
        // to the session's store, so one sync off any destination's new tail is
        // enough — capture the first.
        if (artifactText === null) artifactText = text;
        anyProgress = true;
        roundProgress = true;
        log(
          `  ${path.relative(process.env.HOME ?? "", file.path)} (+${trimmed.length}B → ${step.vaultOrgId ?? "let.ai"}, ${fState.family}, ${fState.sessionId.slice(0, 8)}…)`,
        );
      } catch (err) {
        // One destination's vault being unavailable must not stall the others — log
        // and move on; its offset stays put so the next pass retries just it.
        if (err instanceof HxHttpError && err.serverUnavailable) {
          lastUnavailable = err;
          unavailableDests.add(destKey(step.vaultOrgId));
          log(
            `  [hx] destination ${step.vaultOrgId ?? "let.ai"} unavailable (${err.status}); will retry`,
          );
          continue;
        }
        throw err;
      }
    }

    if (!roundProgress) break;
    // Caught up on every reachable destination? Then this pass is done. A
    // diverged/healing destination (offset reset to 0) simply drains in the
    // remaining rounds like any other backlog.
    const remaining = steps.some(
      (step) =>
        !unavailableDests.has(destKey(step.vaultOrgId)) &&
        offsetFor(fState, step.vaultOrgId) < st.size,
    );
    if (!remaining) break;
  }
  } catch (err) {
    throw classifyUpstreamError(err, route.fortress) ?? err;
  }

  // Nothing landed: if every destination we tried was unavailable, surface it so
  // this file gets skipped (per-session) or the pass pauses (cloud-wide), per
  // classifyUpstreamError. Otherwise there were simply no new committable bytes.
  if (!anyProgress) {
    if (lastUnavailable) throw classifyUpstreamError(lastUnavailable, route.fortress) ?? lastUnavailable;
    return false;
  }

  // Best-effort sidecar sync — a failure must never fail the transcript.
  if (artifactText !== null) {
    await syncArtifacts(cfg, fState, artifactText, log).catch((err) => {
      log(`  [artifacts] ${fState.sessionId.slice(0, 8)}…: ${(err as Error).message}`);
    });
  }
  // A mixed fan-out may have made progress to healthy stores while another
  // destination stayed held. Persist that hold after the healthy commits so
  // status remains below 100% and names the exact blocked destination.
  if (heldBlocker) {
    const err = new HxHttpError(
      503,
      "append-url reported a held vault_offline destination",
      heldBlocker,
    );
    throw new SessionUpstreamUnavailable("vault_offline", 503, err, heldBlocker);
  }
  return true;
}

/**
 * Upload fresh bytes for one child-lane transcript (a subagent's or a workflow
 * agent's jsonl). Same offset-tail + chunk pipeline as the parent, against the
 * dedicated agent endpoints; per-file state reuses the same FileState map
 * (keyed by path), with sessionId = the PARENT session id.
 */
export interface ChildParentIdentity {
  family: string;
  sessionId: string;
}

/**
 * Map Claude's on-disk artifact-directory id to the parent identity hx sends to
 * the gateway. Those ids are usually equal, but Claude Desktop can name the
 * flat file + artifact directory with one UUID while embedding a different
 * canonical sessionId inside the JSONL. Parent FileState already carries the
 * parsed canonical id, so basename -> FileState is the authoritative bridge.
 *
 * Conflicting basename mappings are omitted rather than guessed. Child state
 * entries are excluded so a stale child cannot become its own parent oracle.
 */
export function buildChildParentIndex(state: HxState): Map<string, ChildParentIdentity> {
  const index = new Map<string, ChildParentIdentity>();
  const ambiguous = new Set<string>();
  for (const file of Object.values(state.files)) {
    if (!file.path.endsWith(".jsonl")) continue;
    if (file.path.split(path.sep).includes("subagents")) continue;
    const artifactSessionId = path.basename(file.path, ".jsonl");
    if (artifactSessionId.startsWith("rollout-")) continue;
    if (ambiguous.has(artifactSessionId)) continue;
    const identity = { family: file.family, sessionId: file.sessionId };
    const existing = index.get(artifactSessionId);
    if (
      existing &&
      (existing.family !== identity.family || existing.sessionId !== identity.sessionId)
    ) {
      index.delete(artifactSessionId);
      ambiguous.add(artifactSessionId);
      continue;
    }
    index.set(artifactSessionId, identity);
  }
  return index;
}

/** Repair a persisted child identity after learning its canonical parent. A
 * session-id change means any old offsets refer to the wrong storage prefix, so
 * replay from zero. Either identity change clears failure backoff immediately —
 * a client update should not wait up to 30 minutes before applying the repair. */
export function reconcileChildParent(
  child: FileState,
  parent: ChildParentIdentity | undefined,
): FileState {
  if (!parent) return child;
  const sessionChanged = child.sessionId !== parent.sessionId;
  if (!sessionChanged && child.family === parent.family) return child;
  return {
    ...child,
    family: parent.family,
    sessionId: parent.sessionId,
    offsets: sessionChanged ? {} : child.offsets,
    lastUploadAtMs: sessionChanged ? 0 : child.lastUploadAtMs,
    consecutiveFailures: undefined,
    nextAttemptAtMs: undefined,
    skipReason: undefined,
    healCount: sessionChanged ? undefined : child.healCount,
    healPausedUntilMs: sessionChanged ? undefined : child.healPausedUntilMs,
  };
}

async function ingestChildOne(
  cfg: HxConfig,
  child: DiscoveredChildFile,
  parentByArtifactSession: Map<string, ChildParentIdentity>,
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
  const parent = parentByArtifactSession.get(child.parentSessionId);
  let fState = await getFileState(child.path, scope);
  if (!fState) {
    fState = {
      path: child.path,
      // The child belongs to the parent's session row, so it MUST upload under
      // the parent's canonical family + id or the gateway would mint a sibling.
      family: parent?.family ?? "claude-cli",
      sessionId: parent?.sessionId ?? child.parentSessionId,
      offsets: {},
      lastMtimeMs: st.mtimeMs,
      lastUploadAtMs: 0,
    };
    await upsertFileState(fState, scope);
  } else {
    const reconciled = reconcileChildParent(fState, parent);
    if (reconciled !== fState) {
      fState = reconciled;
      await upsertFileState(fState, scope);
    }
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
  parentByArtifactSession: Map<string, ChildParentIdentity>,
  log: (msg: string) => void,
): Promise<void> {
  const scope = scopeOf(cfg);
  const parent = parentByArtifactSession.get(run.parentSessionId);
  const family = (parent?.family ?? "claude-cli") as never;
  const sessionId = parent?.sessionId ?? run.parentSessionId;
  const journal = await readTextFile(run.journalPath);
  const script = await readTextFile(run.scriptPath);
  if (!journal && !script) return;
  const key = `${String(family)}:${sessionId}:wf:${run.runId}`;
  const hash = hashContent(`${script ?? ""}\n--journal--\n${journal ?? ""}`);
  if ((await getArtifactHash(key, scope)) === hash) return;
  await uploadWorkflowRun(cfg, {
    family,
    sessionId,
    runId: run.runId,
    scriptName: run.scriptName,
    script,
    journal,
  });
  await setArtifactHash(key, hash, scope);
  log(`  [workflow] ${sessionId.slice(0, 8)}…/${run.runId}`);
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
  files = electUploaders(files, state);
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
      if ((fState.healPausedUntilMs ?? 0) > Date.now()) continue; // ping-pong latch
      healed += 1;
      await recordHeal(filePath, scope);
      // Log before the reset — setOffsetFor mutates this same fState object.
      log(
        `  [heal] ${fState.sessionId.slice(0, 8)}… canonical ${r.storeBytes ?? 0}B ≠ uploaded ${offsetFor(fState, null)}B — re-uploading from zero`,
      );
      await setOffsetFor(filePath, null, 0, fState.lastMtimeMs, scope);
    }
  }
  if (healed > 0) log(`[hx] canonical audit: re-uploading ${healed} diverged session(s)`);
}

// Shadowed-twin log dedupe: each hidden path is announced once per process.
const loggedShadowed = new Set<string>();

/**
 * One uploader per canonical. Several local files can map to the same
 * (family, sessionId) — a transcript duplicated under a second project dir
 * when the session's cwd changed, or a codex archive move. Uploading BOTH into
 * one canonical makes every commit's totalBytes mismatch the other file's
 * offset, and the per-commit self-heal then ping-pongs full re-uploads forever
 * (observed live: one session healed from zero 15 times). Elect the
 * most-recently-written file per key (tie: largest) — mtime tracks the LIVE
 * writer (a stale twin's mtime is frozen, so it can't shadow the file new
 * content is actually landing in), which "largest wins" got wrong when a
 * complete-but-dead copy outsized a freshly-restarted live file. The twins
 * are shadowed — skipped by uploads, the audit, and the sync snapshot.
 */
function electUploaders(
  files: DiscoveredFile[],
  state: HxState,
  log?: (msg: string) => void,
): DiscoveredFile[] {
  const byKey = new Map<string, DiscoveredFile[]>();
  const active: DiscoveredFile[] = [];
  for (const f of files) {
    const fs = state.files[f.path];
    // Not seeded yet — passes through this tick (ingestOne seeds it) and joins
    // the election next tick, once its sessionId is known.
    if (!fs) {
      active.push(f);
      continue;
    }
    const key = `${fs.family}:${fs.sessionId}`;
    const list = byKey.get(key) ?? [];
    list.push(f);
    byKey.set(key, list);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
    active.push(list[0]!);
    for (const twin of list.slice(1)) {
      if (log && !loggedShadowed.has(twin.path)) {
        loggedShadowed.add(twin.path);
        log(`[hx] ${twin.path} shadows ${list[0]!.path} (same session); not uploading the twin`);
      }
    }
  }
  return active;
}

/**
 * Catch-up snapshot from the discovered files + the persisted upload offsets:
 * a file is "done" once we've uploaded up to its (discovery-time) size, and
 * every file short of that contributes its remaining bytes to the backlog.
 * Pure in-memory — `state` is the cached object the upload path mutates, so a
 * recompute mid-pass reflects offsets bumped by commits earlier in the pass.
 */
export function snapshotFrom(files: DiscoveredFile[], state: HxState): SyncSnapshot {
  let done = 0;
  let totalBytes = 0;
  for (const f of files) {
    const fs = state.files[f.path];
    // "Done" = the least-current destination has caught up to the file size.
    const offset = fs ? minOffset(fs) : 0;
    // A persisted hold is unfinished even when legacy offsets happen to equal
    // the source size: a destination is still explicitly waiting for bytes.
    if (offset >= f.size && !fs?.skipReason) done += 1;
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
  const settings = await readSettings();
  return snapshotFrom(filterWatched(electUploaders(files, state), state, settings), state);
}

/** A state entry that is no longer discoverable on disk yet never finished
 *  uploading — the server copy is partial and will stay that way. */
export interface SyncBehindEntry {
  path: string;
  sessionId: string;
  uploaded: number;
  lastKnownSize: number;
  /** true = the local file is gone; false = it merely aged out of the
   *  30-day discovery window. */
  sourceGone: boolean;
}

/** A discoverable session whose upload is paused because its destination store
 *  is temporarily unavailable (skipReason set). Transient — it resumes on its
 *  own once the store returns; surfaced so `hx status` explains the lag. */
export interface SyncSkippedEntry {
  path: string;
  family: string;
  sessionId: string;
  reason: FileSkipReason;
  /** When the next upload attempt is due (ms since epoch), if scheduled. */
  nextAttemptAtMs?: number;
  blocker?: FileState["blocker"];
}

export interface SyncReport {
  snapshot: SyncSnapshot;
  behind: SyncBehindEntry[];
  skipped: SyncSkippedEntry[];
}

/** The still-on-disk sessions currently waiting on a temporarily-unavailable
 *  store. Pure over `files` (the elected uploaders) + `state`, so it's
 *  unit-testable. Vanished/aged files are reported via `behind`, not here, so
 *  the two sets never overlap. */
export function collectSkipped(files: DiscoveredFile[], state: HxState): SyncSkippedEntry[] {
  const discovered = new Set(files.map((f) => f.path));
  const out: SyncSkippedEntry[] = [];
  for (const [p, fs] of Object.entries(state.files)) {
    if (!fs.skipReason) continue;
    if (!discovered.has(p)) continue;
    out.push({
      path: p,
      family: fs.family,
      sessionId: fs.sessionId,
      reason: fs.skipReason,
      nextAttemptAtMs: fs.nextAttemptAtMs,
      blocker: fs.blocker,
    });
  }
  return out;
}

/** Sync snapshot PLUS the sessions the snapshot can no longer see: entries
 *  whose source file vanished (or aged out of discovery) mid-upload — and the
 *  sessions currently skipped on a temporarily-unavailable store. Backs the
 *  honest `hx status` output — without these the bar reads 100% while the
 *  server holds partial transcripts or a store is down. */
export async function computeSyncReport(): Promise<SyncReport> {
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles(),
    discoverCodexFiles(),
  ]);
  const all = [...claude, ...codex];
  const state = await loadState();
  const discovered = new Set(all.map((f) => f.path));
  // Sessions still represented by a discovered file (its family:sessionId). A
  // state entry absent from discovery is only a real "gap" if NO current file
  // covers its session — otherwise it's a shadowed twin whose content actually
  // uploaded through the elected file, and whose offsets are frozen BY DESIGN.
  const liveSessions = new Set<string>();
  for (const f of all) {
    const fs = state.files[f.path];
    if (fs) liveSessions.add(`${fs.family}:${fs.sessionId}`);
  }
  const behind: SyncBehindEntry[] = [];
  for (const [p, fs] of Object.entries(state.files)) {
    if (discovered.has(p)) continue;
    if (liveSessions.has(`${fs.family}:${fs.sessionId}`)) continue; // shadowed twin
    if (fs.lastKnownSize === undefined) continue; // legacy entry — size unknown
    const uploaded = minOffset(fs);
    if (uploaded >= fs.lastKnownSize) continue;
    behind.push({
      path: p,
      sessionId: fs.sessionId,
      uploaded,
      lastKnownSize: fs.lastKnownSize,
      sourceGone: !existsSync(p),
    });
  }
  // Settings filtering applies to the ELECTED set only: `discovered` and
  // `liveSessions` above stay unfiltered so an excluded-but-present file can
  // never masquerade as a vanished-source gap.
  const settings = await readSettings();
  const elected = filterWatched(electUploaders(all, state), state, settings);
  return { snapshot: snapshotFrom(elected, state), behind, skipped: collectSkipped(elected, state) };
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
  const settings = await readSettings();
  files = filterWatched(electUploaders(files, state, log), state, settings);
  onProgress?.(snapshotFrom(files, state));

  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    // Per-file backoff: a file that keeps failing (bad request, offline vault)
    // sits out its window instead of burning a gateway round trip every poll.
    const pending = state.files[f.path];
    if (pending?.nextAttemptAtMs && pending.nextAttemptAtMs > Date.now()) continue;
    // A file seen for the first time has no state entry for filterWatched to
    // match — seed it now and re-check before any byte leaves the machine.
    if (!pending) {
      const seeded = await ensureFileState(f, scope);
      if (shouldSkipFile(settings, seeded)) continue;
    }
    try {
      const did = await ingestOne(cfg, f, opts, log);
      if (did) uploaded += 1;
      if (pending?.consecutiveFailures !== undefined || pending?.nextAttemptAtMs !== undefined) {
        await clearFileFailure(f.path, scope);
      }
    } catch (err) {
      failed += 1;
      log(`  [error] ${f.path}: ${(err as Error).message}`);
      if (err instanceof SessionUpstreamUnavailable) {
        // THIS session's store is temporarily unavailable; the shared gateway is
        // fine. Skip just this file — short retries first, then a longer backoff
        // (recordFileFailure doubles per failure) — and record the reason so
        // `hx status` can show it. Everything else keeps uploading.
        const delay = await recordFileFailure(
          f.path,
          SESSION_SKIP_RETRY_BASE_MS,
          scope,
          err.reason,
          err.blocker,
        );
        log(`  [hx] ${describeSkip(err.reason)}; retrying ${path.basename(f.path)} in ${Math.round(delay / 1000)}s`);
        continue;
      }
      if (err instanceof HxHttpError && err.serverUnavailable) {
        // The shared cloud gateway is refusing uploads wholesale — this is NOT
        // this file's fault, so do NOT saddle it with a per-file backoff (that
        // would make this one file lag behind the rest once the gateway
        // recovers). The pass-level exponential backoff in run() handles it.
        log(`  [hx] gateway unavailable (${err.status}); pausing this pass`);
        break;
      }
      // A genuine per-file fault (4xx, parse error, a doomed sidecar): back it
      // off so it doesn't burn a gateway round trip every poll.
      await recordFileFailure(f.path, FILE_RETRY_BASE_MS, scope);
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
    const parentByArtifactSession = buildChildParentIndex(state);
    try {
      const { children, runs } = await discoverClaudeChildren();
      for (const c of children) {
        let pendingChild = state.files[c.path];
        if (pendingChild) {
          const reconciled = reconcileChildParent(
            pendingChild,
            parentByArtifactSession.get(c.parentSessionId),
          );
          if (reconciled !== pendingChild) {
            pendingChild = reconciled;
            await upsertFileState(reconciled, scope);
          }
        }
        if (pendingChild?.nextAttemptAtMs && pendingChild.nextAttemptAtMs > Date.now()) continue;
        try {
          const did = await ingestChildOne(cfg, c, parentByArtifactSession, opts, log);
          if (did) uploaded += 1;
          if (
            pendingChild?.consecutiveFailures !== undefined ||
            pendingChild?.nextAttemptAtMs !== undefined
          ) {
            await clearFileFailure(c.path, scope);
          }
        } catch (err) {
          failed += 1;
          log(`  [error] ${c.path}: ${(err as Error).message}`);
          if (err instanceof HxHttpError && err.vaultOffline) {
            // The child's session vault is offline (child lanes route through the
            // cloud gateway, never fortress-direct) — skip just this child with
            // the same short-retries-then-backoff pacing as its parent.
            await recordFileFailure(
              c.path,
              SESSION_SKIP_RETRY_BASE_MS,
              scope,
              "vault_offline",
              err.blocker,
            );
            continue;
          }
          // A wholesale lane pause (404/401/403) or gateway-wide outage is not
          // this child's fault — don't give it a per-file backoff that would
          // make it lag once the gateway recovers.
          if (latchChildLanePause(err, scope, log)) break;
          if (err instanceof HxHttpError && err.serverUnavailable) break;
          await recordFileFailure(c.path, FILE_RETRY_BASE_MS, scope);
        }
      }
      for (const r of runs) {
        try {
          await syncWorkflowRun(cfg, r, parentByArtifactSession, log);
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

  // User-driven pause (settings.json, written by the UI server or a future
  // CLI). Checked every tick so a pause/resume takes effect within one poll.
  // Heartbeats keep running while paused — the device reads "online, paused",
  // not vanished. Log only the transitions, not every skipped tick.
  let wasPaused = false;

  const run = async () => {
    if (Date.now() < pauseUploadsUntilMs) return;
    if (passBusy) return;
    const settings = await readSettings();
    if (isPaused(settings)) {
      if (!wasPaused) {
        wasPaused = true;
        const until = settings.pause?.untilMs;
        log(`[hx] sync paused${until ? ` until ${new Date(until).toLocaleTimeString()}` : " until resumed"}`);
      }
      return;
    }
    if (wasPaused) {
      wasPaused = false;
      log(`[hx] sync resumed`);
    }
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
