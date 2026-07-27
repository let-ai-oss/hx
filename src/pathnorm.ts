// Path normalization shared by settings.ts (parse/validate) and roots.ts
// (resolution). Lives in its own module so settings can import root
// constants from roots without a require cycle (roots needs this helper).

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

const HOME = homedir();

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
  // Platform-aware: `\` is a legal filename character on POSIX, so stripping
  // it there would silently watch the wrong directory.
  while (
    p.length > 1 &&
    (p.endsWith("/") || (process.platform === "win32" && p.endsWith("\\")))
  ) {
    p = p.slice(0, -1);
  }
  return p;
}
