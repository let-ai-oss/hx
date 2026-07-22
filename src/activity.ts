// Local upload journal — one JSON line per committed chunk, appended by the
// daemon (single writer) and read by the HX Client UI for the hourly-traffic
// chart and "recently sent" stats. Best-effort by design: journal problems
// must never affect uploads, so every function here swallows its errors.
// Nothing in this file uploads anywhere; the journal stays on the machine.

import { appendFile, open, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HX_DIR } from "./hx-home.js";

export const ACTIVITY_PATH = join(HX_DIR, "activity.jsonl");

export interface ActivityEntry {
  /** Epoch ms of the commit. */
  at: number;
  sessionId: string;
  family: string;
  title: string | null;
  /** ~-collapsed folder (session cwd). */
  folder: string | null;
  bytes: number;
  /** Destination store key: "letai" or a vault org id. */
  dest: string;
}

export async function appendActivity(e: ActivityEntry, path: string = ACTIVITY_PATH): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed
    // path under ~/.let/hx (tests inject a tmp path), never request input.
    await appendFile(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  } catch {
    // journal is best-effort
  }
}

const READ_CAP_BYTES = 4 * 1024 * 1024;

export function parseActivityLines(text: string, sinceMs: number): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<ActivityEntry>;
      if (
        typeof e.at === "number" &&
        e.at >= sinceMs &&
        typeof e.bytes === "number" &&
        typeof e.dest === "string" &&
        typeof e.sessionId === "string"
      ) {
        out.push({
          at: e.at,
          sessionId: e.sessionId,
          family: typeof e.family === "string" ? e.family : "unknown",
          title: typeof e.title === "string" ? e.title : null,
          folder: typeof e.folder === "string" ? e.folder : null,
          bytes: e.bytes,
          dest: e.dest,
        });
      }
    } catch {
      // torn/garbage line — skip
    }
  }
  return out;
}

export async function readActivity(sinceMs: number, path: string = ACTIVITY_PATH): Promise<ActivityEntry[]> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see appendActivity.
    const st = await stat(path);
    const start = Math.max(0, st.size - READ_CAP_BYTES);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see appendActivity.
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString("utf-8");
      return parseActivityLines(start > 0 ? text.slice(text.indexOf("\n") + 1) : text, sinceMs);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

const TRIM_AT_BYTES = 2 * 1024 * 1024;
const TRIM_KEEP_BYTES = 1 * 1024 * 1024;

/** Cap the journal: when it outgrows ~2 MB, atomically rewrite the last ~1 MB
 *  (aligned to a line boundary). Called once at daemon start. */
export async function trimActivity(path: string = ACTIVITY_PATH): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see appendActivity.
    const st = await stat(path);
    if (st.size <= TRIM_AT_BYTES) return;
    const start = st.size - TRIM_KEEP_BYTES;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see appendActivity.
    const fh = await open(path, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(TRIM_KEEP_BYTES);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf-8");
    } finally {
      await fh.close();
    }
    const aligned = text.slice(text.indexOf("\n") + 1);
    const tmp = `${path}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see appendActivity.
    await writeFile(tmp, aligned, { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // best-effort
  }
}
