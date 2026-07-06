// `hx uninstall` — tear down the daemon (stop + remove plist/unit),
// remove the binary, and (with --purge) wipe `~/.let/hx/` so a future
// `hx connect` starts from scratch.
//
// Does NOT touch the user's shell-rc PATH entry the installer added —
// removing arbitrary lines from rc files is fraught (the user may have
// edited around it). We instead print the exact line they can delete by
// hand, on the way out.

import { rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDaemonOps, HX_DIR } from "./daemon.js";

const HX_BIN_DEFAULT = join(homedir(), ".let", "bin", "hx");

export interface UninstallOpts {
  /** Also remove ~/.let/hx/ (auth token + state). Default false. */
  purge?: boolean;
  /** Override binary path. Defaults to `~/.let/bin/hx`. */
  binPath?: string;
  log?: (msg: string) => void;
}

export interface UninstallResult {
  /** Daemon was successfully unloaded (or wasn't loaded to begin with). */
  daemonRemoved: boolean;
  /** Binary file was successfully removed. */
  binaryRemoved: boolean;
  /** ~/.let/hx/ was successfully wiped (only true if purge was requested). */
  configPurged: boolean;
  /** Path on disk the binary was at (whether removed or not). */
  binaryPath: string;
}

export async function runUninstall(opts: UninstallOpts = {}): Promise<UninstallResult> {
  const log = opts.log ?? noop;
  const binPath = opts.binPath ?? HX_BIN_DEFAULT;

  let daemonRemoved = false;
  try {
    const ops = getDaemonOps();
    await ops.uninstall();
    daemonRemoved = true;
    log(`removed daemon (${ops.managerName})`);
  } catch (err) {
    log(`warning: daemon teardown failed: ${(err as Error).message}`);
  }

  let binaryRemoved = false;
  if (existsSync(binPath)) {
    try {
      await unlink(binPath);
      binaryRemoved = true;
      log(`removed binary: ${binPath}`);
    } catch (err) {
      log(`warning: could not remove binary at ${binPath}: ${(err as Error).message}`);
    }
  } else {
    log(`binary not found at ${binPath}; skipping`);
  }

  let configPurged = false;
  if (opts.purge && existsSync(HX_DIR)) {
    try {
      await rm(HX_DIR, { recursive: true, force: true });
      configPurged = true;
      log(`purged ${HX_DIR}`);
    } catch (err) {
      log(`warning: could not purge ${HX_DIR}: ${(err as Error).message}`);
    }
  }

  return { daemonRemoved, binaryRemoved, configPurged, binaryPath: binPath };
}

function noop(_: string): void {
  /* no-op log */
}
