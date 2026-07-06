// Daemon lifecycle for `hx start | stop | restart | status | logs`.
//
// macOS uses a per-user LaunchAgent (~/Library/LaunchAgents/<Label>.plist
// loaded with `launchctl bootstrap gui/$uid`). Linux uses a systemd user
// unit (~/.config/systemd/user/hx-vision.service loaded with
// `systemctl --user enable --now`). Both run as the invoking user — no
// sudo, no system writes — and both respawn on crash.
//
// The binary path that gets baked into the plist/unit is whatever
// `process.execPath` is at install time (Bun-compiled binary path, or
// node for tsx engineer runs). `hx update` writes a new binary at the
// SAME path and asks the service manager to restart so the new binary
// takes over.

import { homedir, platform, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { HX_DIR } from "./hx-home.js";

export { HX_DIR };
export const STDOUT_LOG = join(HX_DIR, "stdout.log");
export const STDERR_LOG = join(HX_DIR, "stderr.log");

const LAUNCHD_LABEL = "ai.let.hx-vision";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

const SYSTEMD_UNIT_NAME = "hx-vision.service";
const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);

export interface DaemonState {
  /** Service manager has the unit loaded (regardless of process state). */
  loaded: boolean;
  /** PID of the running daemon process, or null if not running. */
  pid: number | null;
}

export interface DaemonOps {
  install(opts: InstallOpts): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  /**
   * Stop the background service and keep it stopped until `hx start`. A bare
   * unload isn't enough: launchd re-bootstraps everything under
   * ~/Library/LaunchAgents at the next login (systemd user units likewise
   * auto-start when enabled), so stop also disables the service — install()
   * re-enables it. Resolves with whether anything was actually running, and
   * throws if the service survived the stop, so the CLI never reports
   * "stopped" while the daemon is still alive.
   */
  stop(): Promise<{ wasRunning: boolean }>;
  /**
   * Restart the already-installed service so it re-execs the binary at its
   * configured path — used by `hx update` after the binary is atomically
   * swapped in place. Prefers an in-place restart (launchd `kickstart -k`,
   * systemd `restart`) over a bootout→bootstrap cycle, which on macOS can
   * race launchd's teardown and fail with "Bootstrap failed: 5: Input/output
   * error". Throws if the service does not come back up.
   */
  restart(opts: InstallOpts): Promise<void>;
  state(): Promise<DaemonState>;
  /** Pretty-printed name for messages, e.g. "launchd" or "systemd (user)". */
  managerName: string;
}

export interface InstallOpts {
  /** Absolute path to the hx binary that the service manager should exec. */
  binPath: string;
}

export function getDaemonOps(): DaemonOps {
  switch (platform()) {
    case "darwin":
      return macOps();
    case "linux":
      return linuxOps();
    default:
      return unsupportedOps();
  }
}

// ─────────────────────────── macOS / launchd ────────────────────────────

function macTarget(): string {
  return `gui/${userInfo().uid}`;
}

function macState(): DaemonState {
  const r = spawnSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "pipe" });
  if (r.status !== 0) return { loaded: false, pid: null };
  // launchctl list prints a plist-fragment with PID = N or "-" (idle).
  const out = r.stdout.toString();
  const m = out.match(/"PID"\s*=\s*(\d+);/);
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

/** Block the current thread for `ms` without spinning — fine for a one-shot CLI. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `launchctl bootout` returns before launchd has finished tearing the job
 * down. Poll until the label is gone (or we time out) so the bootstrap that
 * follows doesn't collide with the dying job.
 */
function waitUntilUnloaded(maxMs = 2000): void {
  const deadline = Date.now() + maxMs;
  while (macState().loaded && Date.now() < deadline) {
    sleepSync(100);
  }
}

// launchd surfaces the bootout→bootstrap race as a transient I/O error
// ("Bootstrap failed: 5: Input/output error") or an in-progress error
// ("Bootstrap failed: 37: Operation already in progress"). Both clear once the
// old job is fully reaped, so retry a few times with backoff before giving up.
const TRANSIENT_BOOTSTRAP =
  /Bootstrap failed: (5|37|125)\b|Input\/output error|Operation (already|now) in progress/i;

function bootstrapWithRetry(target: string, plistPath: string): void {
  const backoffMs = [150, 300, 600, 1000];
  let lastDetail = "";
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    const r = spawnSync("launchctl", ["bootstrap", target, plistPath], { stdio: "pipe" });
    if (r.status === 0) return;
    lastDetail =
      r.stderr?.toString().trim() || r.stdout?.toString().trim() || `(exit ${r.status})`;
    if (attempt === backoffMs.length || !TRANSIENT_BOOTSTRAP.test(lastDetail)) break;
    sleepSync(backoffMs[attempt]);
  }
  throw new Error(`launchctl bootstrap ${target} ${plistPath} failed: ${lastDetail}`);
}

function macOps(): DaemonOps {
  return {
    managerName: "launchd",
    async install({ binPath }) {
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const plist = renderPlist(binPath);
      await writeFile(LAUNCHD_PLIST, plist);
      const target = macTarget();
      // bootout is the modern "unload"; tolerate "not loaded" so install is idempotent.
      spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      // Let launchd finish reaping the old job before bootstrapping the new one,
      // and retry the bootstrap through the transient teardown race.
      waitUntilUnloaded();
      // Enable BEFORE bootstrap: `hx stop` disables the service (so a relogin
      // can't resurrect it), and bootstrapping a disabled service fails with
      // "Bootstrap failed: 119". Enabling an already-enabled service is a no-op.
      runOrThrow("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`]);
      bootstrapWithRetry(target, LAUNCHD_PLIST);
    },
    async restart({ binPath }) {
      // Refresh the on-disk plist so a changed binary path is captured.
      await mkdir(dirname(LAUNCHD_PLIST), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(LAUNCHD_PLIST, renderPlist(binPath));
      const target = macTarget();
      const label = `${target}/${LAUNCHD_LABEL}`;
      if (macState().loaded) {
        // In-place restart: kill the running instance and respawn it from the
        // same plist, re-exec'ing the binary at its (now atomically-swapped)
        // path. This sidesteps the bootout→bootstrap teardown race entirely.
        runOrThrow("launchctl", ["kickstart", "-k", label]);
      } else {
        // Not currently loaded — bring it up from scratch. Enable first: the
        // service may have been disabled by `hx stop`, and bootstrapping a
        // disabled service fails.
        runOrThrow("launchctl", ["enable", label]);
        bootstrapWithRetry(target, LAUNCHD_PLIST);
      }
    },
    async uninstall() {
      const target = macTarget();
      spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      if (existsSync(LAUNCHD_PLIST)) {
        await unlink(LAUNCHD_PLIST);
      }
    },
    async start() {
      runOrThrow("launchctl", ["kickstart", "-k", `${macTarget()}/${LAUNCHD_LABEL}`]);
    },
    async stop() {
      const target = macTarget();
      // Disable first so the stop sticks: launchd re-bootstraps everything in
      // ~/Library/LaunchAgents at the next login, so a plain bootout means
      // "stopped until you next log in" — not what "Run `hx start` to resume"
      // promises. install() re-enables. Disabling is independent of load state,
      // so do it even when the job isn't currently loaded.
      spawnSync("launchctl", ["disable", `${target}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
      const before = macState();
      if (!before.loaded) return { wasRunning: false };
      const r = spawnSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], { stdio: "pipe" });
      // bootout returns before launchd finishes tearing the job down — wait,
      // then confirm the label is actually gone instead of reporting success
      // blind (the old fire-and-forget printed "stopped" even on failure).
      waitUntilUnloaded();
      if (macState().loaded) {
        const detail =
          r.stderr?.toString().trim() || r.stdout?.toString().trim() || `(exit ${r.status})`;
        throw new Error(`launchctl bootout ${target}/${LAUNCHD_LABEL} failed: ${detail}`);
      }
      return { wasRunning: true };
    },
    async state() {
      return macState();
    },
  };
}

// ─────────────────────────── Linux / systemd ────────────────────────────

function linuxState(): DaemonState {
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT_NAME], { stdio: "pipe" });
  const loaded = enabled.status === 0;
  const show = spawnSync(
    "systemctl",
    ["--user", "show", SYSTEMD_UNIT_NAME, "--property=MainPID"],
    { stdio: "pipe" },
  );
  if (show.status !== 0) return { loaded, pid: null };
  const m = show.stdout.toString().match(/MainPID=(\d+)/);
  const pid = m ? Number(m[1]) : 0;
  return { loaded, pid: pid > 0 ? pid : null };
}

function linuxOps(): DaemonOps {
  return {
    managerName: "systemd (user)",
    async install({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      const unit = renderSystemdUnit(binPath);
      await writeFile(SYSTEMD_UNIT_PATH, unit);
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
      runOrThrow("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    },
    async restart({ binPath }) {
      await mkdir(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(SYSTEMD_UNIT_PATH, renderSystemdUnit(binPath));
      runOrThrow("systemctl", ["--user", "daemon-reload"]);
      // `restart` re-execs ExecStart (the swapped binary) when running, and
      // starts the unit when it was stopped — either way we end up running.
      runOrThrow("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
    },
    async uninstall() {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { stdio: "ignore" });
      if (existsSync(SYSTEMD_UNIT_PATH)) {
        await unlink(SYSTEMD_UNIT_PATH);
      }
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    },
    async start() {
      runOrThrow("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
    },
    async stop() {
      const before = linuxState();
      // disable --now = stop now AND drop the login autostart, so "stopped"
      // holds until `hx start` re-enables (mirrors the launchd disable).
      // Tolerate a missing unit so stop stays idempotent.
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { stdio: "ignore" });
      // Verify instead of trusting the exit code: is-active exits 0 only while
      // the unit is still running.
      const active = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME], { stdio: "pipe" });
      if (active.status === 0) {
        throw new Error(`systemctl --user disable --now ${SYSTEMD_UNIT_NAME} failed: unit still active`);
      }
      return { wasRunning: before.pid !== null };
    },
    async state() {
      return linuxState();
    },
  };
}

// ───────────────────────── Unsupported platforms ─────────────────────────

function unsupportedOps(): DaemonOps {
  const msg = `hx daemon mode is not yet supported on ${platform()}. Use \`hx watch\` to run in a terminal.`;
  return {
    managerName: "none",
    async install() {
      throw new Error(msg);
    },
    async restart() {
      throw new Error(msg);
    },
    async uninstall() {
      // No-op; nothing to remove on unsupported platforms.
    },
    async start() {
      throw new Error(msg);
    },
    async stop(): Promise<{ wasRunning: boolean }> {
      throw new Error(msg);
    },
    async state() {
      return { loaded: false, pid: null };
    },
  };
}

// ─────────────────────────────── Templates ────────────────────────────────

function renderPlist(binPath: string): string {
  // The daemon runs `hx watch`, which reads the gateway + token from
  // ~/.let/hx/config.json — so no HX_GATEWAY_URL is injected into the service
  // environment. That's deliberate: a stale env var must never be able to
  // override config (the bug that broke `hx update` on a connected device).
  const envEntries: Array<[string, string]> = [
    ["PATH", "/usr/local/bin:/usr/bin:/bin"],
  ];
  const envBlock = envEntries
    .map(([k, v]) => `      <key>${k}</key><string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(binPath)}</string>
      <string>watch</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>StandardOutPath</key><string>${escapeXml(STDOUT_LOG)}</string>
    <key>StandardErrorPath</key><string>${escapeXml(STDERR_LOG)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envBlock}
    </dict>
  </dict>
</plist>
`;
}

function renderSystemdUnit(binPath: string): string {
  // No HX_GATEWAY_URL in the unit: `hx watch` reads the gateway + token from
  // ~/.let/hx/config.json, and a stale env var must never override config.
  return `[Unit]
Description=hx-vision session mirror
After=network-online.target

[Service]
Type=simple
ExecStart=${binPath} watch
Restart=always
RestartSec=5
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}

[Install]
WantedBy=default.target
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runOrThrow(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() ?? "";
    const stdout = r.stdout?.toString().trim() ?? "";
    const detail = stderr || stdout || `(exit ${r.status})`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
  }
}

// ─────────────────────────────── tail logs ────────────────────────────────

/**
 * Run `tail -f` on the daemon's stdout + stderr logs. Inherits stdio so the
 * user sees output directly; on Ctrl+C, exits cleanly.
 */
export async function tailLogs(linesBack = 50): Promise<void> {
  await mkdir(HX_DIR, { recursive: true });
  // Touch logs if they don't exist so tail doesn't error out.
  for (const p of [STDOUT_LOG, STDERR_LOG]) {
    if (!existsSync(p)) {
      await writeFile(p, "");
    }
  }
  const proc = spawn(
    "tail",
    ["-n", String(linesBack), "-f", STDOUT_LOG, STDERR_LOG],
    { stdio: "inherit" },
  );
  await new Promise<void>((resolve) => {
    const onSig = () => proc.kill("SIGINT");
    process.once("SIGINT", onSig);
    proc.once("exit", () => {
      process.removeListener("SIGINT", onSig);
      resolve();
    });
  });
}
