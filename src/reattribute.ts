// The versioned attribution sweep — the retro half of "hx update fixes
// history".
//
// The watch loop never re-reports metadata for a fully-uploaded file (the
// skip in ingestOne fires before readHead), so a session whose repo went
// undetected at upload time stayed unattributed FOREVER — invisible to every
// Team Sessions board (the Maksim/1,018 incident). This sweep runs once per
// DETECTION_VERSION per file, on daemon start after an update: it re-detects
// each already-uploaded session's repo with the CURRENT detection chain
// (first-sight cache → filesystem walk → encoded workdir name) and reports
// either the resolved slug or the session's cwd as EVIDENCE for server-side
// org rules, via POST /sessions/reattribute — a PG-only endpoint that moves no
// bytes and re-routes no storage.
//
// Discovery is deliberately UNWINDOWED (maxAgeMs: Infinity): live ingest
// prunes to 30 days for cadence, but the sweep must reach every file still on
// disk (~8 weeks of retention) — those older sessions are exactly the ones
// most likely to predate detection fixes. Files with no upload state are
// skipped: they have no server row to repair (live ingest owns them).
//
// Failure model: a batch that fails (network, or a gateway predating the
// route) aborts the sweep WITHOUT stamping the remaining files' version, so
// the next daemon start simply retries. Stamping is per-file and follows the
// successful batch that contained it.

import { readHead, discoverClaudeFiles, discoverCodexFiles } from "./sources.js";
import { getFileState, upsertFileState, type StateScope } from "./state.js";
import {
  reattributeSessions,
  type ReattributeItem,
  type ReattributeResult,
} from "./uploader.js";
import type { HxConfig } from "./config.js";

/** Bump when the detection chain learns a new trick (encoded workdir names,
 *  non-origin remotes, …) so every already-swept file gets one more look. */
export const DETECTION_VERSION = 2;

const BATCH_SIZE = 100;

export interface SweepSummary {
  scanned: number;
  sent: number;
  attributed: number;
  unresolved: number;
  skipped: number;
}

export async function runReattributeSweep(
  cfg: HxConfig,
  scope: StateScope,
  log: (msg: string) => void,
  opts: { force?: boolean } = {},
): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, sent: 0, attributed: 0, unresolved: 0, skipped: 0 };
  const [claude, codex] = await Promise.all([
    discoverClaudeFiles({ maxAgeMs: Infinity }),
    discoverCodexFiles({ maxAgeMs: Infinity }),
  ]);
  const files = [...claude, ...codex];

  type Pending = { item: ReattributeItem; stamp: () => Promise<void> };
  const pending: Pending[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const { results } = await reattributeSessions(cfg, batch.map((p) => p.item));
    const byKey = new Map<string, ReattributeResult>(
      results.map((r) => [`${r.family}:${r.sessionId}`, r]),
    );
    for (const p of batch) {
      const r = byKey.get(`${p.item.family}:${p.item.sessionId}`);
      if (r?.status === "attributed") summary.attributed += 1;
      else summary.unresolved += 1;
      summary.sent += 1;
      await p.stamp();
    }
  };

  for (const file of files) {
    const fState = await getFileState(file.path, scope);
    // No upload state ⇒ no server row to repair; live ingest owns the file.
    if (!fState || Object.keys(fState.offsets).length === 0) continue;
    if (!opts.force && (fState.attributionVersion ?? 0) >= DETECTION_VERSION) {
      summary.skipped += 1;
      continue;
    }
    summary.scanned += 1;
    const head = await readHead(file.path, file.source);
    // FIRST-SIGHT wins over the sweep-time walk: the cached slug was detected
    // while the session actually ran; a re-walk months later can resolve a
    // REUSED scratch path to whatever repo lives there NOW. The fresh walk
    // only fills a cache that has nothing.
    const repoSlug = fState.repoSlug ?? head.repoSlug ?? null;
    const cwd = fState.cwd ?? head.cwd ?? null;
    // Keep the local cache current regardless of what the server run yields.
    fState.repoSlug = repoSlug;
    fState.cwd = cwd;
    // evidenceUpload:false doesn't just withhold — it RETRACTS: the server may
    // hold cwd from before the opt-out, and opting out should mean gone.
    const withholdCwd = cfg.evidenceUpload === false;
    const sendCwd = !withholdCwd && !!cwd;
    if (!repoSlug && !sendCwd && !withholdCwd) {
      // Nothing to report — stamp so the daemon doesn't re-read this file on
      // every start; the next DETECTION_VERSION bump revisits it.
      fState.attributionVersion = DETECTION_VERSION;
      await upsertFileState(fState, scope);
      summary.unresolved += 1;
      continue;
    }
    pending.push({
      item: {
        family: fState.family as ReattributeItem["family"],
        sessionId: fState.sessionId,
        ...(repoSlug ? { repoSlug } : {}),
        ...(sendCwd ? { cwd: cwd! } : {}),
        ...(withholdCwd ? { withholdCwd: true } : {}),
      },
      stamp: async () => {
        fState.attributionVersion = DETECTION_VERSION;
        await upsertFileState(fState, scope);
      },
    });
    if (pending.length >= BATCH_SIZE) await flush();
  }
  await flush();

  if (summary.sent > 0 || summary.scanned > 0) {
    log(
      `[reattribute] v${DETECTION_VERSION}: ${summary.sent} reported ` +
        `(${summary.attributed} attributed), ${summary.unresolved} unresolved, ` +
        `${summary.skipped} already current`,
    );
  }
  return summary;
}
