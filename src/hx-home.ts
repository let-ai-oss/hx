// All hx client state lives under ~/.let/hx, so the `hx` and `hx-session-vault`
// tools share one home (binaries under ~/.let/bin). Earlier builds kept state in
// ~/.hx; migrate it once, on first load, so existing device ids, auth tokens and
// upload offsets carry over with no re-auth.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

export const HX_DIR = join(homedir(), ".let", "hx");
const LEGACY_HX_DIR = join(homedir(), ".hx");

let done = false;

/** Move ~/.hx → ~/.let/hx once, then ensure the directory exists. Idempotent. */
export function ensureHxHome(): string {
  if (done) return HX_DIR;
  done = true;
  if (!existsSync(HX_DIR) && existsSync(LEGACY_HX_DIR)) {
    try {
      mkdirSync(join(homedir(), ".let"), { recursive: true });
      renameSync(LEGACY_HX_DIR, HX_DIR);
    } catch {
      // Cross-device move or permission issue — leave the legacy dir untouched;
      // callers mkdir(HX_DIR) and start fresh (a rare one-time re-auth).
    }
  }
  mkdirSync(HX_DIR, { recursive: true });
  return HX_DIR;
}

// Migrate as soon as any state module imports this.
ensureHxHome();
