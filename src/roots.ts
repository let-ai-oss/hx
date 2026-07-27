// Data-root resolution — WHICH config-dir roots hx watches, per family.
//
// Claude Code relocates its entire ~/.claude tree when CLAUDE_CONFIG_DIR is
// set; Codex does the same for ~/.codex via CODEX_HOME. hx therefore models
// watch locations as ROOTS (the config dir itself, never the projects/ or
// sessions/ subdir) and derives the per-family subpaths from each root.
//
// Sources, in precedence order (first occurrence of a physical dir wins):
//   • default  — ~/.claude / ~/.codex; always present, not removable;
//   • settings — dataDirs in ~/.let/hx/settings.json (UI-managed);
//   • env      — CLAUDE_CONFIG_DIR / CODEX_HOME from THIS process's env.
//
// Env honor is strictly per-process: the launchd/systemd daemon never sees
// shell-profile exports, so the settings list is the durable source of truth
// and env is a convenience for `hx watch` / shell-hook / one-shot runs. The
// long-running daemon stamps its resolved set into state.json (watch.ts) and
// the UI server treats that stamp as device truth. NO login-shell probing —
// product-decided; we read our own environment, nothing else's.

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeDataDir, type HxSettings } from "./settings.js";

export type RootOrigin = "default" | "settings" | "env";

export interface DataRoot {
  /** Absolute config-dir root (the CLAUDE_CONFIG_DIR / CODEX_HOME value). */
  configDir: string;
  origin: RootOrigin;
  exists: boolean;
}

export interface ResolvedRoots {
  claude: DataRoot[];
  codex: DataRoot[];
}

const HOME = os.homedir();
export const DEFAULT_CLAUDE_ROOT = path.join(HOME, ".claude");
export const DEFAULT_CODEX_ROOT = path.join(HOME, ".codex");

// Derived per-root subpaths — the actual watch surface.
export const claudeProjectsDir = (root: string): string => path.join(root, "projects");
export const claudeTasksDir = (root: string): string => path.join(root, "tasks");
export const claudeTeamsDir = (root: string): string => path.join(root, "teams");
export const codexSessionsDir = (root: string): string => path.join(root, "sessions");
export const codexArchivedDir = (root: string): string => path.join(root, "archived_sessions");

function resolveFamily(
  defaultRoot: string,
  fromSettings: string[],
  fromEnv: string | undefined,
): DataRoot[] {
  const out: DataRoot[] = [];
  const seen = new Set<string>();
  const push = (raw: string, origin: RootOrigin): void => {
    // Everything funnels through the same normalization as settings entries,
    // so a relative or garbage env value is dropped, never half-honored.
    const dir = origin === "default" ? raw : normalizeDataDir(raw);
    if (!dir) return;
    const exists = existsSync(dir);
    // Physical identity for the dedupe: a symlinked twin of a watched root
    // must not double-mirror the same tree. Missing dirs (allowed — they arm
    // for when the dir appears) dedupe by their normalized name.
    let key = dir;
    if (exists) {
      try {
        key = realpathSync(dir);
      } catch {
        /* unreadable — keep the normalized name as identity */
      }
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ configDir: dir, origin, exists });
  };
  push(defaultRoot, "default");
  for (const d of fromSettings) push(d, "settings");
  if (fromEnv) push(fromEnv, "env");
  return out;
}

/** Resolve the full watch-root set for THIS process (settings + own env). */
export function resolveDataRoots(
  s: HxSettings,
  env: Record<string, string | undefined> = process.env,
): ResolvedRoots {
  return {
    claude: resolveFamily(DEFAULT_CLAUDE_ROOT, s.dataDirs.claude, env.CLAUDE_CONFIG_DIR),
    codex: resolveFamily(DEFAULT_CODEX_ROOT, s.dataDirs.codex, env.CODEX_HOME),
  };
}

/** True when `p` is (or sits under) one of the roots' config dirs. */
export function isUnderRoots(p: string, roots: DataRoot[]): boolean {
  for (const r of roots) {
    if (p === r.configDir || p.startsWith(r.configDir + path.sep)) return true;
  }
  return false;
}

/** Identity of a resolved set — drives the daemon's stamp-on-change. */
export function rootsSignature(r: ResolvedRoots): string {
  const part = (list: DataRoot[]): string =>
    list.map((d) => `${d.origin}:${d.configDir}:${d.exists ? 1 : 0}`).join("|");
  return `${part(r.claude)}§${part(r.codex)}`;
}
