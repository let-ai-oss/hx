// Single-instance bookkeeping for `hx ui`.
//
// While the server runs it keeps ~/.let/hx/ui/server.json (0600):
//   { port, pid, launchToken }
// A second `hx ui` that finds its port taken reads this file, verifies the
// occupant really is a live hx-ui owned by this user (unauthenticated
// /api/instance identity + an authenticated exchange with the stored launch
// token), and re-opens the browser at the running instance instead of
// starting a rival server. A crash leaves a stale file; the verification
// fails and the caller cleans it up and moves on.

import { mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HX_DIR } from "../hx-home.js";
import { HX_VERSION } from "../version.js";

export const UI_DIR = join(HX_DIR, "ui");

const infoPath = (dir: string): string => join(dir, "server.json");

export interface ServerInfo {
  port: number;
  pid: number;
  launchToken: string;
}

export async function writeServerInfo(info: ServerInfo, dir: string = UI_DIR): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is
  // UI_DIR under ~/.let/hx (tests inject a tmpdir), never request input.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = infoPath(dir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

export async function readServerInfo(dir: string = UI_DIR): Promise<ServerInfo | null> {
  try {
    const raw = await readFile(infoPath(dir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServerInfo>;
    // Strict shape gate: the port feeds a loopback probe URL, so it must be a
    // real port number, not arbitrary file content.
    if (
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65535 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.launchToken !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.launchToken)
    ) {
      return null;
    }
    return parsed as ServerInfo;
  } catch {
    return null;
  }
}

export async function removeServerInfo(dir: string = UI_DIR): Promise<void> {
  await unlink(infoPath(dir)).catch(() => {});
}

/** Identity payload of GET /api/instance — deliberately free of secrets. */
export interface InstanceIdentity {
  app: "hx-ui";
  version: string;
}

export function instanceIdentity(): InstanceIdentity {
  return { app: "hx-ui", version: HX_VERSION };
}

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Is the recorded instance alive, ours, and answering on its port? Returns
 * the launch URL to re-open when yes; null means "treat as stale".
 */
export async function probeExistingInstance(
  info: ServerInfo,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string } | null> {
  const base = `http://127.0.0.1:${info.port}`;
  try {
    const identityRes = await fetcher(`${base}/api/instance`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!identityRes.ok) return null;
    const identity = (await identityRes.json()) as Partial<InstanceIdentity>;
    if (identity.app !== "hx-ui") return null;

    // Ownership proof: only the process that wrote server.json (same uid —
    // the file is 0600) knows the launch token, and only the real server
    // accepts it. A foreign app squatting the port fails here.
    const authRes = await fetcher(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: info.launchToken }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!authRes.ok) return null;

    return { url: `http://localhost:${info.port}/#k=${info.launchToken}` };
  } catch {
    return null;
  }
}
