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
import { writeFile, mkdir, unlink, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
  /**
   * True when install()/restart() may edit the user's shell dotfiles and the
   * caller should ask for consent first — the container shell-hook backend.
   * Absent on managers that own their own system files (launchd, systemd).
   */
  needsDotfileConsent?: boolean;
  /** Shell-hook backend only: are the startup dotfiles already wired? Lets the
   *  caller skip re-prompting on repeat `hx connect` / `hx start`. */
  dotfilesWired?(): boolean;
}

export interface InstallOpts {
  /** Absolute path to the hx binary that the service manager should exec. */
  binPath: string;
  /**
   * Shell-hook (container) backend only: whether the user allowed editing
   * ~/.bashrc / ~/.profile so the mirror restarts with the container. Ignored
   * by the launchd / systemd backends, which don't touch dotfiles.
   */
  dotfileConsent?: "granted" | "denied";
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
    lastDetail = failureDetail(r);
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
        throw new Error(`launchctl bootout ${target}/${LAUNCHD_LABEL} failed: ${failureDetail(r)}`);
      }
      return { wasRunning: true };
    },
    async state() {
      return macState();
    },
  };
}

// ─────────────────────────── Linux / systemd ────────────────────────────

// systemd user services need a running per-user manager AND a session bus to
// reach it. Containers (and other minimal Linux images) usually have neither —
// and may not ship `systemctl` at all — so `systemctl --user …` fails before it
// does any work. Probe with a cheap read: `show-environment` exits 0 only when
// the user bus is actually reachable. Returns the failure reason, or null when
// the session is available.
function systemdUserError(): string | null {
  const r = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "pipe" });
  if (!r.error && r.status === 0) return null;
  return failureDetail(r);
}

function probeOk(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return !r.error && r.status === 0;
}

// The shell-hook backend needs bash (the shell whose startup files we hook) and
// setsid (to launch the mirror in its own session so it survives the sourcing
// shell exiting, and so `hx stop` can kill the whole process group). Both ship
// on any real Linux; probing keeps the "not supported" path honest on images
// stripped down past them.
function containerToolsAvailable(): boolean {
  return probeOk("bash", ["-c", "exit 0"]) && probeOk("sh", ["-c", "command -v setsid >/dev/null 2>&1"]);
}

// Linux has three background backends, chosen at runtime by capability:
//   • systemd user session reachable → the systemd unit (laptops, servers);
//   • else bash + setsid present     → the shell-startup hook (containers);
//   • else                           → unsupported, with a `hx watch` pointer.
function linuxOps(): DaemonOps {
  if (systemdUserError() === null) return systemdOps();
  if (containerToolsAvailable()) return shellHookOps();
  return unsupportedOps(
    `hx can't run in the background here: no systemd user session, and no bash + ` +
      `setsid to hook into. Run \`hx watch\` to mirror in the foreground instead.`,
  );
}

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

function systemdOps(): DaemonOps {
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

// ───────────────────── Linux / container (shell hook) ─────────────────────
//
// No systemd user session (Docker, minimal images) → keep hx alive by hooking
// the shell's startup files: a guarded launcher at ~/.let/hx/bootstrap.sh,
// sourced from ~/.bashrc and ~/.profile. Every bash shell the container starts —
// including the one it re-runs on `docker restart` — re-launches the mirror if
// it isn't already up. This is the only restart-durable mechanism that doesn't
// require controlling the container's entrypoint. Editing the user's dotfiles
// needs consent (DaemonOps.needsDotfileConsent); without it we still run for the
// current session but can't persist across a restart.

const BOOTSTRAP_PATH = join(HX_DIR, "bootstrap.sh");
const WATCH_PID_PATH = join(HX_DIR, "watch.pid");
const DISABLED_FLAG_PATH = join(HX_DIR, "disabled");
const CONFIG_JSON_PATH = join(HX_DIR, "config.json");
const HOOK_DOTFILES = [join(homedir(), ".bashrc"), join(homedir(), ".profile")];
const HOOK_BEGIN = "# >>> hx >>>";
const HOOK_END = "# <<< hx <<<";

/** POSIX single-quote a string so it can't break out of the generated script. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The line each dotfile sources. Absolute path (not $HOME-relative) so it's
// unambiguous, shell-quoted so an odd install path can't break it.
function hookSourceLine(): string {
  return `[ -f ${shquote(BOOTSTRAP_PATH)} ] && . ${shquote(BOOTSTRAP_PATH)}`;
}

// The launcher hx writes to bootstrap.sh. Runs on every bash startup; the guards
// keep it a no-op once connected+running, and self-heals on crash (while-loop
// mirrors systemd Restart=always / RestartSec=5). setsid detaches it into its
// own session/process-group so exiting the sourcing shell doesn't kill it and
// `hx stop` can group-kill it.
export function renderBootstrap(binPath: string): string {
  const cfg = shquote(CONFIG_JSON_PATH);
  const disabled = shquote(DISABLED_FLAG_PATH);
  const pid = shquote(WATCH_PID_PATH);
  const bin = shquote(binPath);
  const logf = shquote(STDOUT_LOG);
  const loop = `echo $$ > ${pid}; while true; do ${bin} watch >> ${logf} 2>&1; sleep 5; done`;
  return `# Managed by hx — do not edit. Regenerated by \`hx start\` / \`hx update\`.
# True only when $1 is a live, non-zombie process. \`kill -0\` alone reports a
# zombie (dead-but-unreaped, common under a non-reaping container PID 1) as
# alive, which would wedge the relaunch below — so check /proc state directly.
__hx_alive() {
  [ -n "$1" ] || return 1
  __st=$(cat /proc/"$1"/stat 2>/dev/null) || return 1
  __st=\${__st##*) }   # strip through the last ") " → "<state> <ppid> ..."
  case \${__st%% *} in Z|X|x|"") return 1 ;; *) return 0 ;; esac
}
__hx_boot() {
  [ -f ${cfg} ] || return          # not connected → nothing to mirror
  [ -f ${disabled} ] && return      # \`hx stop\` set this flag
  [ -x ${bin} ] || return
  __hx_alive "$(cat ${pid} 2>/dev/null)" && return   # already running
  setsid sh -c ${shquote(loop)} >/dev/null 2>&1 &
}
__hx_boot; unset -f __hx_boot __hx_alive; unset __st
`;
}

/**
 * Supervisor pid from the pidfile, or null if absent/garbage. Requires pid > 1:
 * killWatch group-kills `-pid`, and `kill(-1)` is the POSIX "signal every
 * process" special case — a corrupt pidfile must never be able to trigger it.
 * Our supervisor is always a child (pid > 1), so this rejects nothing real.
 */
function readWatchPid(): number | null {
  try {
    const n = Number(readFileSync(WATCH_PID_PATH, "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

// Liveness via /proc, NOT `kill(pid, 0)` — the latter succeeds for a zombie
// (a dead process not yet reaped), and containers routinely leave zombies
// because PID 1 isn't a reaping init. A zombie supervisor must read as dead so
// `hx stop` doesn't report a false "survived" and the hook relaunches after a
// crash. Linux-only, which is fine: this backend only runs on Linux.
function pidAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Format: `pid (comm) state ...`; comm may contain ')' so scan past the last.
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim()[0];
    return state !== "Z" && state !== "X" && state !== "x";
  } catch {
    return false; // no /proc entry → gone
  }
}

function dotfilesWired(): boolean {
  return HOOK_DOTFILES.some((f) => {
    try {
      return readFileSync(f, "utf8").includes(HOOK_BEGIN);
    } catch {
      return false;
    }
  });
}

/** Append the hx marker block, unless already present (idempotent). Pure. */
export function insertHookBlock(content: string): string {
  if (content.includes(HOOK_BEGIN)) return content;
  return `${content}\n${HOOK_BEGIN}\n${hookSourceLine()}\n${HOOK_END}\n`;
}

/** Remove the hx marker block (and its surrounding newlines). Pure. */
export function stripHookBlock(content: string): string {
  const re = new RegExp(`\\n?${escapeRegExp(HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(HOOK_END)}\\n?`, "g");
  return content.replace(re, "\n");
}

async function wireDotfiles(): Promise<void> {
  for (const f of HOOK_DOTFILES) {
    let cur = "";
    try {
      cur = await readFile(f, "utf8");
    } catch {
      // missing → create it (never create ~/.bash_profile: it would shadow the
      // user's existing ~/.profile for login shells).
    }
    const next = insertHookBlock(cur);
    if (next !== cur) await writeFile(f, next);
  }
}

async function unwireDotfiles(): Promise<void> {
  for (const f of HOOK_DOTFILES) {
    let cur: string;
    try {
      cur = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (!cur.includes(HOOK_BEGIN)) continue;
    await writeFile(f, stripHookBlock(cur));
  }
}

// Run bootstrap.sh once, now, so `hx start` / `hx connect` brings the mirror up
// in this session without waiting for a new shell. Same guards as the hook, so
// it's a no-op when already running. The setsid child reparents to init and
// outlives this call.
function launchNow(): void {
  spawnSync("sh", [BOOTSTRAP_PATH], { stdio: "ignore" });
  // The detached supervisor writes its pidfile a beat after we return; wait for
  // it (briefly) so the caller's state() reflects the running process rather
  // than racing it and reporting "will respawn on demand" for a live daemon.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const pid = readWatchPid();
    if (pid !== null && pidAlive(pid)) return;
    sleepSync(50);
  }
}

// Kill the supervisor's whole process group (setsid made its pid the group
// leader), so the respawn loop AND the running `hx watch` both die. Poll for the
// group to clear, escalating to SIGKILL. Returns whether it was running.
function killWatch(): boolean {
  const pid = readWatchPid();
  if (pid === null) return false;
  const wasRunning = pidAlive(pid);
  try {
    process.kill(-pid, "SIGTERM"); // whole group: supervisor + its `hx watch`
  } catch {
    // group already gone
  }
  const deadline = Date.now() + 1500;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(100);
  // Unconditional final SIGKILL sweeps any straggler in the group (e.g. an
  // `hx watch` that outlived a zombied supervisor); harmless if already dead.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
  sleepSync(100);
  return wasRunning;
}

function shellHookState(): DaemonState {
  const loaded = existsSync(BOOTSTRAP_PATH) && !existsSync(DISABLED_FLAG_PATH);
  const pid = readWatchPid();
  return { loaded, pid: pid !== null && pidAlive(pid) ? pid : null };
}

function shellHookOps(): DaemonOps {
  return {
    managerName: "shell hook (container)",
    needsDotfileConsent: true,
    dotfilesWired,
    async install({ binPath, dotfileConsent }) {
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(BOOTSTRAP_PATH, renderBootstrap(binPath));
      await unlink(DISABLED_FLAG_PATH).catch(() => {}); // re-enable (mirror systemd)
      if (dotfileConsent === "granted") await wireDotfiles();
      launchNow();
    },
    async restart({ binPath, dotfileConsent }) {
      // `hx update` swapped the binary in place — regenerate with the (possibly
      // new) path, kill the old process, relaunch.
      await mkdir(HX_DIR, { recursive: true });
      await writeFile(BOOTSTRAP_PATH, renderBootstrap(binPath));
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      if (dotfileConsent === "granted") await wireDotfiles();
      killWatch();
      await unlink(WATCH_PID_PATH).catch(() => {});
      launchNow();
    },
    async uninstall() {
      killWatch();
      await unlink(WATCH_PID_PATH).catch(() => {});
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      await unlink(BOOTSTRAP_PATH).catch(() => {});
      await unwireDotfiles();
    },
    async start() {
      await unlink(DISABLED_FLAG_PATH).catch(() => {});
      launchNow();
    },
    async stop() {
      // disabled flag = stay stopped across new shells and restarts (bootstrap
      // checks it), mirroring the launchd/systemd disable-on-stop.
      await writeFile(DISABLED_FLAG_PATH, "");
      const wasRunning = killWatch();
      const after = readWatchPid();
      if (after !== null && pidAlive(after)) {
        throw new Error(`hx background process (pid ${after}) survived stop`);
      }
      await unlink(WATCH_PID_PATH).catch(() => {});
      return { wasRunning };
    },
    async state() {
      return shellHookState();
    },
  };
}

// ───────────────────────── Unsupported platforms ─────────────────────────

function unsupportedOps(
  msg = `hx daemon mode is not yet supported on ${platform()}. Use \`hx watch\` to run in a terminal.`,
): DaemonOps {
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

// Turn a spawnSync result into a human-readable failure reason. When the
// process couldn't even be launched (binary missing, no bus to connect to)
// spawnSync leaves `status` null/undefined and puts the real cause on `error` —
// surface that instead of a meaningless "(exit undefined)".
function failureDetail(r: ReturnType<typeof spawnSync>): string {
  if (r.error) return r.error.message;
  const stderr = r.stderr?.toString().trim() ?? "";
  const stdout = r.stdout?.toString().trim() ?? "";
  return stderr || stdout || `exit ${r.status ?? "unknown"}`;
}

function runOrThrow(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.error || r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${failureDetail(r)}`);
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
