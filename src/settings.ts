// Device-local sync settings — the daemon-honored side of the HX Client UI's
// privacy controls. Lives in ~/.let/hx/settings.json (0600). The watch loop
// re-reads it every tick (it's tiny), so a change from the UI server — a
// separate process — takes effect within one poll interval. This file is the
// ONLY channel between the UI server and the running daemon: state.json stays
// single-writer (the daemon).
//
// Semantics (product-decided):
//   • pause      — uploads stop entirely; the daemon stays alive, heartbeats
//                  continue (the device reads "online, paused" — not vanished).
//   • personalSync=false — sessions that would attach to no workspace stay on
//                  this machine. Device-side signal: a session whose folder
//                  has NO detected git repo (repoSlug === null). A repo whose
//                  attribution is UNKNOWN (legacy state entry, repoSlug
//                  undefined) uploads — the safe default is "work".
//   • excludedFolders / excludeRules — never upload matching folders. Rules
//                  are ~-collapsed path prefixes and also cover folders that
//                  don't exist yet.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { HX_DIR } from "./hx-home.js";

export const SETTINGS_PATH = join(HX_DIR, "settings.json");

export interface ExcludedFolder {
  family: string;
  /** ~-collapsed working directory, as shown in the UI. */
  cwd: string;
}

export interface HxSettings {
  /** null = not paused; untilMs null = paused until manually resumed. */
  pause: { untilMs: number | null } | null;
  personalSync: boolean;
  excludedFolders: ExcludedFolder[];
  excludeRules: string[];
}

export const DEFAULT_SETTINGS: HxSettings = {
  pause: null,
  personalSync: true,
  excludedFolders: [],
  excludeRules: [],
};

export async function readSettings(path: string = SETTINGS_PATH): Promise<HxSettings> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed
    // path under ~/.let/hx (tests inject a tmp path), never request input.
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HxSettings>;
    return {
      pause:
        parsed.pause && typeof parsed.pause === "object"
          ? { untilMs: typeof parsed.pause.untilMs === "number" ? parsed.pause.untilMs : null }
          : null,
      personalSync: parsed.personalSync !== false,
      excludedFolders: Array.isArray(parsed.excludedFolders)
        ? parsed.excludedFolders.filter(
            (f): f is ExcludedFolder =>
              typeof f?.family === "string" && typeof f?.cwd === "string",
          )
        : [],
      excludeRules: Array.isArray(parsed.excludeRules)
        ? parsed.excludeRules.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS, excludedFolders: [], excludeRules: [] };
  }
}

export async function writeSettings(
  patch: Partial<HxSettings>,
  path: string = SETTINGS_PATH,
): Promise<HxSettings> {
  const current = await readSettings(path);
  const next: HxSettings = { ...current, ...patch };
  const tmp = `${path}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readSettings.
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return next;
}

export function isPaused(s: HxSettings, nowMs = Date.now()): boolean {
  if (!s.pause) return false;
  if (s.pause.untilMs === null) return true;
  return nowMs < s.pause.untilMs;
}

const HOME = homedir();

export function collapseHome(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

/** Prefix match on ~-collapsed paths, boundary-aware ("~/a" ≠ "~/ab"). */
function ruleMatches(rule: string, cwd: string): boolean {
  const r = rule.replace(/\/+$/, "");
  if (!r) return false;
  return cwd === r || cwd.startsWith(`${r}/`);
}

export interface FileSyncIdentity {
  family: string;
  /** ~-collapsed cwd; undefined = unknown (legacy state entry). */
  cwd?: string;
  /** null = known to have no repo; undefined = unknown. */
  repoSlug?: string | null;
  /** Gateway-confirmed workspace attribution; false = repo attaches to no
   *  workspace (personal); undefined = unknown (older gateway / unresolved). */
  attributed?: boolean;
}

/**
 * Should this file stay on the machine under the current settings?
 * Personal = no repo, or a repo the gateway confirmed attaches to no
 * workspace. Unknown identity (legacy entries, older gateways) never
 * matches — the safe default is to keep uploading work.
 */
export function shouldSkipFile(s: HxSettings, id: FileSyncIdentity): boolean {
  if (id.cwd !== undefined) {
    for (const ex of s.excludedFolders) {
      if (ex.family === id.family && ex.cwd === id.cwd) return true;
    }
    for (const rule of s.excludeRules) {
      if (ruleMatches(rule, id.cwd)) return true;
    }
  }
  if (!s.personalSync && (id.repoSlug === null || id.attributed === false)) return true;
  return false;
}
