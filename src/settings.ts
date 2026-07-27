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
//   • dataDirs   — extra data-dir ROOTS to watch besides ~/.claude / ~/.codex
//                  (the CLAUDE_CONFIG_DIR / CODEX_HOME value itself, never the
//                  projects/ or sessions/ subdir). Entries may not exist yet —
//                  like excludeRules, they arm for when the dir appears.

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { HX_DIR } from "./hx-home.js";

export const SETTINGS_PATH = join(HX_DIR, "settings.json");

export interface ExcludedFolder {
  family: string;
  /** ~-collapsed working directory, as shown in the UI. */
  cwd: string;
}

/** Extra watch roots per family, normalized absolute paths. */
export interface DataDirs {
  claude: string[];
  codex: string[];
}

export interface HxSettings {
  /** null = not paused; untilMs null = paused until manually resumed. */
  pause: { untilMs: number | null } | null;
  personalSync: boolean;
  excludedFolders: ExcludedFolder[];
  excludeRules: string[];
  dataDirs: DataDirs;
}

export const DEFAULT_SETTINGS: HxSettings = {
  pause: null,
  personalSync: true,
  excludedFolders: [],
  excludeRules: [],
  dataDirs: { claude: [], codex: [] },
};

/** Hard cap per family — bounds the discovery fan-out a config can demand. */
export const MAX_DATA_DIRS_PER_FAMILY = 8;

/**
 * Normalize one data-dir root: trim, expand a leading `~`, require an
 * absolute path, collapse `.`/`..` segments and trailing separators. Returns
 * null for anything unusable (relative, empty, control characters) — callers
 * drop such entries rather than half-honoring them. Env values go through
 * this exact same funnel (see roots.ts) so a garbage CLAUDE_CONFIG_DIR can't
 * produce a non-canonical root.
 */
export function normalizeDataDir(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p || /[\0\r\n]/.test(p)) return null;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  if (!isAbsolute(p)) return null;
  p = normalize(p);
  // normalize() preserves a trailing separator — strip it (never the root).
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);
  return p;
}

function parseDataDirList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const dir = normalizeDataDir(item);
    if (!dir || out.includes(dir)) continue;
    out.push(dir);
    if (out.length >= MAX_DATA_DIRS_PER_FAMILY) break;
  }
  return out;
}

/** Parse + normalize a dataDirs value from disk or a settings patch. */
export function parseDataDirs(v: unknown): DataDirs {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return { claude: parseDataDirList(o.claude), codex: parseDataDirList(o.codex) };
}

/**
 * Strict validation for a dataDirs PATCH from the UI server. Where the disk
 * parser silently drops garbage (a hand-edited file shouldn't brick the
 * daemon), an API write must reject it loudly. Returns an error message, or
 * null when the value is acceptable.
 */
export function dataDirsPatchError(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "dataDirs must be an object";
  for (const key of Object.keys(v)) {
    if (key !== "claude" && key !== "codex") return `unknown dataDirs family: ${key}`;
  }
  for (const family of ["claude", "codex"] as const) {
    const list = (v as Record<string, unknown>)[family];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `dataDirs.${family} must be an array`;
    if (list.length > MAX_DATA_DIRS_PER_FAMILY) {
      return `dataDirs.${family}: at most ${MAX_DATA_DIRS_PER_FAMILY} locations`;
    }
    for (const item of list) {
      if (typeof item !== "string") return `dataDirs.${family}: entries must be strings`;
      if (!normalizeDataDir(item)) {
        return `dataDirs.${family}: not an absolute (or ~-prefixed) path`;
      }
    }
  }
  return null;
}

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
      dataDirs: parseDataDirs(parsed.dataDirs),
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      excludedFolders: [],
      excludeRules: [],
      dataDirs: { claude: [], codex: [] },
    };
  }
}

export async function writeSettings(
  patch: Partial<HxSettings>,
  path: string = SETTINGS_PATH,
): Promise<HxSettings> {
  const current = await readSettings(path);
  const next: HxSettings = { ...current, ...patch };
  // dataDirs merges PER FAMILY: the validator accepts a patch that names only
  // one family, so an omitted family must mean "unchanged" — a whole-object
  // replace would silently erase the other family's roots on a 200. Also
  // normalize on write as well as read, so a patch that arrived un-normalized
  // (older UI, hand-edited file) never persists a non-canonical root.
  const patchDirs = (patch as { dataDirs?: unknown }).dataDirs;
  if (patchDirs !== undefined && patchDirs !== null && typeof patchDirs === "object" && !Array.isArray(patchDirs)) {
    const pd = patchDirs as Record<string, unknown>;
    next.dataDirs = parseDataDirs({
      claude: pd.claude === undefined ? current.dataDirs.claude : pd.claude,
      codex: pd.codex === undefined ? current.dataDirs.codex : pd.codex,
    });
  } else {
    next.dataDirs = parseDataDirs(next.dataDirs);
  }
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
