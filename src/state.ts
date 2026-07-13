// ~/.let/hx/state.json holds per-file upload offsets.
//
// On every successful chunk-commit we bump the offset for that file. On
// startup we restore offsets and skip already-uploaded bytes. A JSON file
// (atomic write via rename) is the right primitive — no native deps, no
// concurrent writers (a single hx process owns it).
//
// State is scoped per upload lane: the regular gateway's offsets live in
// state.json, while the `--local` tee lane (the same files, mirrored to the
// local dev gateway in addition) keeps its own in state.local.json. Each
// gateway has its own "how many bytes of this file do you already hold"
// truth, so the lanes must never share offsets or artifact hashes.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { HX_DIR } from "./hx-home.js";

/** Which upload lane's state to read/write: "main" = the configured gateway,
 *  "local" = the additive `--local` tee against the local dev gateway. */
export type StateScope = "main" | "local";

export interface FileState {
  /** Absolute jsonl path on disk. */
  path: string;
  /** Family classification (claude-desktop/claude-cli/codex-desktop/codex-cli/unknown). */
  family: string;
  /** The session id we extracted from the jsonl (used as the GCS key prefix). */
  sessionId: string;
  /** Byte offset already uploaded, PER destination store. Key = vaultOrgId, or
   *  "letai" for the let.ai shared bucket (null orgId). A session whose repo is
   *  attached to several orgs fans out to several stores, each advancing
   *  independently. */
  offsets: Record<string, number>;
  /** Last mtime we observed (ms). Skip the file if mtime hasn't moved. */
  lastMtimeMs: number;
  /** Last upload attempt timestamp (ms). For logging/inspection. */
  lastUploadAtMs: number;
  /** Size (bytes) the file had when we last saw it on disk. Lets `hx status`
   *  report sessions whose source vanished (or aged out of the scan window)
   *  before their upload finished — the server copy stays partial forever, and
   *  without this record the status would silently claim 100%. */
  lastKnownSize?: number;
  /** Consecutive canonical self-heals (from-zero re-uploads) without a clean
   *  commit in between. A mismatch that heals and immediately re-diverges is
   *  ping-ponging (e.g. two writers on one canonical) — after a few rounds the
   *  heal pauses instead of re-uploading the whole file forever. */
  healCount?: number;
  /** Self-heal is paused for this file until this timestamp (ms). */
  healPausedUntilMs?: number;
  /** Consecutive failed upload attempts (cleared by any clean pass). Drives a
   *  per-file retry backoff so one permanently-broken file can't burn a
   *  gateway round trip every poll while everything else is healthy. */
  consecutiveFailures?: number;
  /** Do not retry this file before this timestamp (ms since epoch). */
  nextAttemptAtMs?: number;
}

/** On-disk shape before per-destination fan-out carried a single `offset`. */
export interface LegacyFileState {
  path: string;
  family: string;
  sessionId: string;
  offset?: number;
  offsets?: Record<string, number>;
  lastMtimeMs: number;
  lastUploadAtMs: number;
}

/** Stable per-destination state key. null (let.ai shared bucket) → "letai". */
export function destKey(vaultOrgId: string | null): string {
  return vaultOrgId ?? "letai";
}

/** Bytes already committed to one destination (0 if never written there). */
export function offsetFor(s: FileState, vaultOrgId: string | null): number {
  return s.offsets[destKey(vaultOrgId)] ?? 0;
}

/** Lowest committed offset across all known destinations (0 if none yet). The
 *  "has the file grown past everything we've sent?" skip check uses this so a
 *  destination still behind the others keeps getting bytes. */
export function minOffset(s: FileState): number {
  const vals = Object.values(s.offsets);
  return vals.length === 0 ? 0 : Math.min(...vals);
}

/** Upgrade a possibly-legacy persisted entry to the per-destination shape. A
 *  legacy single offset becomes the let.ai destination's offset; any other
 *  destination is implicitly 0 and re-uploads from zero (replace) on next pass. */
export function migrateFileState(s: LegacyFileState): FileState {
  const offsets = s.offsets ?? (typeof s.offset === "number" ? { letai: s.offset } : {});
  return {
    path: s.path,
    family: s.family,
    sessionId: s.sessionId,
    offsets,
    lastMtimeMs: s.lastMtimeMs,
    lastUploadAtMs: s.lastUploadAtMs,
    lastKnownSize: (s as FileState).lastKnownSize,
    consecutiveFailures: (s as FileState).consecutiveFailures,
    nextAttemptAtMs: (s as FileState).nextAttemptAtMs,
    healCount: (s as FileState).healCount,
    healPausedUntilMs: (s as FileState).healPausedUntilMs,
  };
}

export interface HxState {
  files: Record<string, FileState>;
  /** Content-hash per uploaded sidecar artifact (key `<family>:<sessionId>:<kind>`)
   *  so tasks/plans only re-upload when their content actually changes. */
  artifacts?: Record<string, string>;
}

const STATE_DIR = HX_DIR;
const STATE_FILE: Record<StateScope, string> = {
  main: "state.json",
  local: "state.local.json",
};

const inMemory = new Map<StateScope, HxState>();
const writeChains = new Map<StateScope, Promise<void>>();

function statePath(scope: StateScope): string {
  return path.join(STATE_DIR, STATE_FILE[scope]);
}

export async function loadState(scope: StateScope = "main"): Promise<HxState> {
  const cached = inMemory.get(scope);
  if (cached) return cached;
  let state: HxState;
  if (!existsSync(statePath(scope))) {
    state = { files: {} };
  } else {
    try {
      const raw = await readFile(statePath(scope), "utf8");
      state = JSON.parse(raw) as HxState;
    } catch {
      state = { files: {} };
    }
  }
  if (!state.files) state.files = {};
  // Upgrade any legacy single-offset entries to the per-destination shape. The
  // declared type is already FileState, but on-disk data may predate `offsets`.
  for (const [k, v] of Object.entries(state.files)) {
    state.files[k] = migrateFileState(v);
  }
  inMemory.set(scope, state);
  return state;
}

async function persist(state: HxState, scope: StateScope): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const target = statePath(scope);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

/** Chain writes per scope so we never have two writers racing on one file. */
function schedulePersist(state: HxState, scope: StateScope): Promise<void> {
  const chain = (writeChains.get(scope) ?? Promise.resolve())
    .then(() => persist(state, scope))
    .catch(() => persist(state, scope));
  writeChains.set(scope, chain);
  return chain;
}

export async function getFileState(
  filePath: string,
  scope: StateScope = "main",
): Promise<FileState | null> {
  const state = await loadState(scope);
  return state.files[filePath] ?? null;
}

export async function upsertFileState(
  s: FileState,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  state.files[s.path] = s;
  await schedulePersist(state, scope);
}

/** Record the bytes committed to ONE destination for a file. Other destinations'
 *  offsets are untouched, so an offline vault never rolls back a healthy one. */
export async function setOffsetFor(
  filePath: string,
  vaultOrgId: string | null,
  offset: number,
  mtimeMs: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  existing.offsets[destKey(vaultOrgId)] = offset;
  existing.lastMtimeMs = mtimeMs;
  existing.lastUploadAtMs = Date.now();
  await schedulePersist(state, scope);
}

/**
 * Reconcile a file's per-destination offsets against the gateway's CURRENT
 * fan-out set for its session (both ready and held destinations — a held
 * vault is expected back and must keep its offset). A destination that left
 * the set (org detached, vault decommissioned) would otherwise pin
 * minOffset — and with it the sync percentage — below done forever, since
 * nothing ever wrote to it again and no other code path removes offset keys.
 */
export async function reconcileDestinations(
  filePath: string,
  activeKeys: string[],
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  const keep = new Set(activeKeys);
  let changed = false;
  for (const k of Object.keys(existing.offsets)) {
    if (keep.has(k)) continue;
    delete existing.offsets[k];
    changed = true;
  }
  if (changed) await schedulePersist(state, scope);
}

/** Refresh a file's observed mtime without advancing any destination's offset
 *  (the file changed but produced no new committable bytes). */
export async function touchMtime(
  filePath: string,
  mtimeMs: number,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return;
  existing.lastMtimeMs = mtimeMs;
  await schedulePersist(state, scope);
}

/** Per-file retry backoff cap — a broken file retries at most every 30 min. */
const FILE_BACKOFF_CAP_MS = 30 * 60_000;

/** Record a failed upload attempt for one file and schedule its next try with
 *  exponential backoff from `baseMs`. Returns the chosen delay (ms). */
export async function recordFileFailure(
  filePath: string,
  baseMs: number,
  scope: StateScope = "main",
): Promise<number> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return 0;
  const n = (existing.consecutiveFailures ?? 0) + 1;
  existing.consecutiveFailures = n;
  const delay = Math.min(FILE_BACKOFF_CAP_MS, baseMs * 2 ** (n - 1));
  existing.nextAttemptAtMs = Date.now() + delay;
  await schedulePersist(state, scope);
  return delay;
}

/** How many consecutive self-heals one file may burn before the heal pauses. */
export const HEAL_MAX_CONSECUTIVE = 3;
/** How long a ping-ponging file's self-heal stays paused. */
export const HEAL_PAUSE_MS = 6 * 60 * 60_000;

/** Count a canonical self-heal for one file; pauses healing once the streak
 *  hits HEAL_MAX_CONSECUTIVE. Returns the streak length. */
export async function recordHeal(
  filePath: string,
  scope: StateScope = "main",
): Promise<number> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing) return 0;
  const n = (existing.healCount ?? 0) + 1;
  existing.healCount = n;
  if (n >= HEAL_MAX_CONSECUTIVE) {
    existing.healPausedUntilMs = Date.now() + HEAL_PAUSE_MS;
  }
  await schedulePersist(state, scope);
  return n;
}

/** A clean, size-matching commit ends any heal streak. */
export async function clearHeal(
  filePath: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing || (existing.healCount === undefined && existing.healPausedUntilMs === undefined)) {
    return;
  }
  delete existing.healCount;
  delete existing.healPausedUntilMs;
  await schedulePersist(state, scope);
}

/** Clear a file's failure backoff after a clean pass. */
export async function clearFileFailure(
  filePath: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  const existing = state.files[filePath];
  if (!existing || (existing.consecutiveFailures === undefined && existing.nextAttemptAtMs === undefined)) {
    return;
  }
  delete existing.consecutiveFailures;
  delete existing.nextAttemptAtMs;
  await schedulePersist(state, scope);
}

export async function getArtifactHash(
  key: string,
  scope: StateScope = "main",
): Promise<string | null> {
  const state = await loadState(scope);
  return state.artifacts?.[key] ?? null;
}

export async function setArtifactHash(
  key: string,
  hash: string,
  scope: StateScope = "main",
): Promise<void> {
  const state = await loadState(scope);
  if (!state.artifacts) state.artifacts = {};
  state.artifacts[key] = hash;
  await schedulePersist(state, scope);
}
