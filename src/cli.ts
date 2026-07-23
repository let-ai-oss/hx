#!/usr/bin/env bun
// hx — laptop daemon for hx-vision. Mirrors local jsonl session files to
// hx-gateway. Per-user, per-device.

import {
  localConfigPath,
  readConfig,
  readLocalConfig,
  writeConfig,
  writeLocalConfig,
  type HxConfig,
} from "./config.js";
import { connect } from "./connect.js";
import { backfillArtifacts, computeSyncReport, computeSyncSnapshot, startWatch, tickOnce } from "./watch.js";
import { getDaemonOps, tailLogs, type DaemonOps, type DaemonState } from "./daemon.js";
import { probeConnection, formatRate } from "./probe.js";
import { runUpdate, type UpdateProgress, type UpdateResult } from "./update.js";
import { ProgressBar } from "./progress.js";
import { runUninstall } from "./uninstall.js";
import { HX_VERSION } from "./version.js";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { assertSecureFetchUrl } from "./net.js";
import {
  buildSyncDoctorReport,
  formatStatusBlocker,
  formatSyncDoctorText,
} from "./diagnostics.js";
import { isPaused, readSettings, writeSettings, type HxSettings } from "./settings.js";
import { daemonAction, disconnectDevice, retryBlocked } from "./maintenance.js";
import { checkForUpdate } from "./update.js";
import { watch as watchDir } from "node:fs";
import { HX_DIR } from "./hx-home.js";
import { openBrowser } from "./browser.js";
import { loadUiAssets } from "./ui/assets.js";
import { createUiAuth, LAUNCH_TTL_MS } from "./ui/auth.js";
import {
  probeExistingInstance,
  readServerInfo,
  removeServerInfo,
  writeServerInfo,
} from "./ui/instance.js";
import { createEventHub, tryServeUi, type UiActions, type UiProviders } from "./ui/server.js";
import {
  activitySince,
  buildSessions,
  buildSnapshot,
  cachedWhoami,
  isDiscoveredPath,
  readConfigForProbe,
  tailDaemonLog,
} from "./ui/data.js";
import { previewSessionFile } from "./ui/preview.js";

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

// The single line `hx version` prints. Shared so `hx update` can echo it last.
function versionLine(): string {
  return `hx version: ${HX_VERSION}`;
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  for (const a of process.argv) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function ensureConfig() {
  const cfg = await readConfig();
  // A config with a gatewayBaseUrl but no accessToken is "configured but not
  // connected" (freshly installed, or post-`hx disconnect`) — these commands
  // upload, so they need the token, not just the URL.
  if (!cfg?.accessToken) {
    log("Not connected. Run `hx connect` first.");
    process.exit(2);
  }
  return cfg;
}

// The single-origin dev gateway that `pnpm dev` mounts at localhost:9000.
// `--local` is ADDITIVE: `hx connect --local` pairs this device with the local
// gateway as a second connection (token in config.local.json, main config
// untouched), and `hx watch --local` / `hx tick --local` then mirror every
// session to it IN ADDITION to the regular gateway — regular behavior is
// unchanged, the local lane runs the same pipeline with its own offsets
// (state.local.json). `hx update --local` fetches the binary from it.
//
// This is the ONLY hard-coded URL left: there is no `--gateway` flag, no
// `$HX_GATEWAY_URL` env var, and no silent production default. Every command
// otherwise reads the gateway from `~/.let/hx/config.json` (seeded by the
// installer, written by `hx connect`), so a stale shell-env export can never
// again hijack which gateway a connected device talks to — the bug this
// resolution model was rewritten to kill.
const LOCAL_GATEWAY_URL = "http://localhost:9000/workbench/_api/hx-gateway";

/**
 * The gateway a command talks to. Exactly two sources, in priority order:
 *   1. `--local`     → the hard-coded localhost dev gateway (LOCAL_GATEWAY_URL).
 *      Only `hx update` still reaches this branch — connect/watch/tick handle
 *      `--local` themselves as the additive tee lane before getting here.
 *   2. saved config  → `gatewayBaseUrl` in ~/.let/hx/config.json.
 * Returns undefined when neither applies (not installed/connected, no --local).
 * Callers turn that into a clear error rather than inventing a URL.
 */
async function resolveGatewayUrl(): Promise<string | undefined> {
  if (hasFlag("local")) return LOCAL_GATEWAY_URL;
  const cfg = await readConfig();
  return cfg?.gatewayBaseUrl;
}

/**
 * `resolveGatewayUrl` or exit(2) with a concrete next step. Used by commands
 * that can't do anything useful without a gateway (connect, update). Keeping
 * the message terse + actionable: reinstall (seeds prod) or --local (dev).
 */
async function requireGatewayUrl(): Promise<string> {
  const url = await resolveGatewayUrl();
  if (!url) {
    log("No gateway configured. Reinstall hx from your let.ai workbench,");
    log("or pass --local to use the local dev gateway.");
    process.exit(2);
  }
  return url;
}

/**
 * The `--local` tee lane's connection (config.local.json, minted by
 * `hx connect --local`) — or exit(2) with the fix. Upload commands call this
 * only when `--local` is passed; the returned config carries
 * stateScope:"local" so the pipeline keeps the lane's own offsets.
 */
async function ensureLocalConfig(): Promise<HxConfig> {
  const cfg = await readLocalConfig();
  if (!cfg?.accessToken) {
    log("Local tee is not connected. Run `hx connect --local` first.");
    process.exit(2);
  }
  return cfg;
}

// Bring up — or kick — the launchd / systemd background mirror so every
// `hx connect` (first or n-th) resumes the sync and drives it toward 100%.
//
// The daemon reads the device token from config ONCE at startup and holds it in
// memory, and it backs off exponentially (up to 5 min) when uploads fail. So a
// daemon that's already loaded can be wedged in two ways that the old "it's
// already running" no-op would never clear:
//   • its in-memory token was revoked and reminted by this very `hx connect` —
//     every upload/heartbeat then 401s (`tokenRefreshed` flags this caller);
//   • it's parked in a long upload backoff with a real backlog left.
// Either way the cure is a restart: the fresh process re-reads config (new
// token), the in-memory backoff resets, and `hx watch` runs a full catch-up
// pass on boot. We skip the restart only when the daemon is up, the token is
// unchanged, and the local snapshot is already caught up — nothing to resume.
//
// Failures here don't fail connect itself: the device is approved, so we surface
// a (re)start failure as a note and tell them how to recover.
// Ask before editing the user's shell dotfiles (the container shell-hook
// backend). Returns "granted" without prompting when the backend doesn't touch
// dotfiles, or they're already wired; declines silently when there's no TTY to
// ask on (so a piped/non-interactive run never edits files behind the user's
// back).
async function resolveDotfileConsent(ops: DaemonOps): Promise<"granted" | "denied"> {
  if (!ops.needsDotfileConsent) return "granted";
  if (ops.dotfilesWired?.()) return "granted";
  // Non-interactive opt-in, for scripted container setup: `hx start --yes`.
  if (hasFlag("yes") || process.argv.includes("-y")) return "granted";
  if (!process.stdin.isTTY) return "denied";
  log("");
  log("To keep running after this container restarts, hx adds one line to");
  log("~/.bashrc and ~/.profile so it relaunches whenever a bash shell starts.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question("Allow hx to edit those files? [Y/n] ")).trim().toLowerCase();
    return ans === "" || ans === "y" || ans === "yes" ? "granted" : "denied";
  } finally {
    rl.close();
  }
}

// Success line after a (re)start, plus — for the container backend when the user
// declined the dotfile edit — how to make it survive a restart.
function reportStarted(ops: DaemonOps, ds: DaemonState, consent: "granted" | "denied"): void {
  const pidStr = ds.pid ? `, pid ${ds.pid}` : "";
  log(`hx started (${ops.managerName}${pidStr}).`);
  if (ops.needsDotfileConsent && consent === "denied") {
    log("");
    log("hx is running now, but WON'T restart with the container. To persist it,");
    log("add this line to ~/.bashrc and ~/.profile:");
    log(`  [ -f "$HOME/.let/hx/bootstrap.sh" ] && . "$HOME/.let/hx/bootstrap.sh"`);
    log("or re-run `hx start` and allow the edit.");
  }
}

async function autoStartDaemon(
  gatewayBaseUrl: string,
  opts: { tokenRefreshed?: boolean } = {},
): Promise<void> {
  const binPath = process.execPath;
  try {
    const ops = getDaemonOps();
    const before = await ops.state();
    if (!before.loaded) {
      // First connect (or after `hx stop`): install + start. The fresh daemon
      // re-reads config and runs an immediate catch-up pass on its own.
      const dotfileConsent = await resolveDotfileConsent(ops);
      await ops.install({ binPath, dotfileConsent });
      const after = await ops.state();
      reportStarted(ops, after, dotfileConsent);
      log(`  status: hx status   logs: hx logs   stop: hx stop`);
      return;
    }
    // Already loaded — restart it if the token was just reminted (it's holding
    // the revoked one) or there's still a backlog to push. A user-paused device
    // is deliberately behind — restarting wouldn't (and shouldn't) change that.
    const settings = await readSettings();
    const snap = await computeSyncSnapshot().catch(() => null);
    const behind = !isPaused(settings) && (snap ? snap.done < snap.total : false);
    const remaining = snap ? Math.max(0, snap.total - snap.done) : 0;
    if (opts.tokenRefreshed || behind) {
      const dotfileConsent = await resolveDotfileConsent(ops);
      await ops.restart({ binPath, dotfileConsent });
      if (behind) {
        const s = remaining === 1 ? "" : "s";
        log(`hx restarted (${ops.managerName}) — resuming sync (${remaining} session${s} left).`);
      } else {
        log(`hx restarted (${ops.managerName}).`);
      }
    } else {
      log(`hx is running (${ops.managerName}) — sync up to date.`);
    }
  } catch (err) {
    log("");
    log(`note: could not (re)start the background service:`);
    log(`  ${(err as Error).message}`);
    log(`fix that and run \`hx start\`, or run \`hx watch\` to mirror in this terminal.`);
  }
}

async function cmdConnect(): Promise<void> {
  // `hx connect --local` pairs the ADDITIVE local-dev tee, leaving the main
  // connection (and the daemon) untouched — it never re-points config.json.
  if (hasFlag("local")) return cmdConnectLocal();
  // The gateway the installer seeded / a prior connect saved. No --gateway
  // flag, no env var: a fresh machine with neither is an error, not a silent
  // localhost default.
  const gatewayBaseUrl = await requireGatewayUrl();
  const noStart = process.argv.includes("--no-start");

  // Already connected from this machine, to THIS gateway? Re-running `hx
  // connect` would open the browser and approve a *second* token for the same
  // device — duplicate "connections" on the device list, and (while the
  // daemon's upload backlog was saturating the API) the approve page hanging
  // for 20s. Ask the gateway who this token is (one bounded /whoami call — the
  // authoritative "is this device still connected" check) and short-circuit
  // while it authenticates, pointing them at `hx disconnect`.
  //
  // Only short-circuit when the saved config targets the gateway we're about to
  // use: a different one (e.g. `hx connect --local` over a prod config) is a
  // deliberate switch, so fall through and overwrite.
  //
  // Report the GATEWAY's device name, not the locally cached one: the approve
  // page lets the user (re)name the device ("Mac (alex)") while the local
  // cache keeps the hostname-derived default ("host.local (alex)"),
  // so echoing the cache sent users hunting the Devices page for a row that
  // doesn't exist — or matches a stale duplicate they just disconnected. The
  // fresh name is written back so later messages agree with the Devices page.
  //
  // A token revoked from the web (Vision settings → Devices → Disconnect)
  // makes /whoami 401, falling through to a fresh connect, which overwrites
  // the old config.
  const existing = await readConfig();
  if (existing?.accessToken && existing.gatewayBaseUrl === gatewayBaseUrl) {
    const who = await fetchWhoami(existing);
    if (who.ok) {
      const deviceName = who.deviceName ?? existing.deviceName;
      const email = who.email ?? existing.email;
      if (deviceName !== existing.deviceName || email !== existing.email) {
        await writeConfig({ ...existing, deviceName, email });
      }
      log(`This device is already connected as "${deviceName}".`);
      log(`Run \`hx disconnect\` first if you want to reconnect it.`);
      // The saved token still authenticates, so the daemon's token is fine —
      // but a stalled sync (backlog left in upload backoff) should still resume.
      // autoStartDaemon revives a dead mirror and restarts a live-but-behind one.
      if (!noStart) await autoStartDaemon(gatewayBaseUrl);
      return;
    }
    if (who.unauthorized) {
      log(`This device's previous connection was revoked — reconnecting.`);
    }
    // Gateway unreachable falls through too: the fresh connect surfaces a real
    // error from its first request instead of dead-ending here.
  }

  const deviceName = flag("device-name");
  await connect({ gatewayBaseUrl, deviceName, log });

  // Two-command install: customers run `curl … | sh` then `hx connect`, and
  // that's it. Implicit start brings up the launchd / systemd unit so the
  // mirror is running before they leave the terminal. We just minted a fresh
  // token, so an already-running daemon is holding the now-revoked one — flag
  // the refresh so autoStartDaemon restarts it to pick up the new token.
  if (noStart) return;
  await autoStartDaemon(gatewayBaseUrl, { tokenRefreshed: true });
}

// `hx connect --local` — pair this device with the LOCAL dev gateway as a
// second, additive connection: the tee lane `hx watch --local` / `hx tick
// --local` mirror to. Its token lives in config.local.json; the main
// config.json (and the background daemon mirroring to it) are not touched.
// Same already-connected short-circuit as the main connect, against the
// local lane's own config — a revoked token falls through to a fresh pair.
async function cmdConnectLocal(): Promise<void> {
  const existing = await readLocalConfig();
  if (existing?.accessToken) {
    const who = await fetchWhoami(existing);
    if (who.ok) {
      const deviceName = who.deviceName ?? existing.deviceName;
      log(`This device is already connected to the local dev gateway as "${deviceName}".`);
      log(`Run \`hx disconnect --local\` first if you want to reconnect it.`);
      return;
    }
    if (who.unauthorized) {
      log(`This device's local connection was revoked — reconnecting.`);
    }
    // Local gateway unreachable falls through too: the fresh connect surfaces
    // a real error from its first request instead of dead-ending here.
  }

  const deviceName = flag("device-name");
  // Dev stacks don't all listen on 9000 (agent stacks boot on a different port
  // base). --local-port swaps ONLY the loopback port — the host stays
  // hard-coded, so this cannot become a remote-gateway hijack vector (the
  // resolution model deliberately has no --gateway flag / env override).
  const portFlag = flag("local-port");
  const gatewayBaseUrl =
    portFlag && /^\d{1,5}$/.test(portFlag)
      ? `http://localhost:${portFlag}/workbench/_api/hx-gateway`
      : LOCAL_GATEWAY_URL;
  await connect({
    gatewayBaseUrl,
    deviceName,
    log,
    persist: writeLocalConfig,
  });
  log("");
  log(`Local tee ready: \`hx watch --local\` and \`hx tick --local\` now mirror`);
  log(`sessions to ${gatewayBaseUrl} in addition to the regular gateway.`);
}

// The `--local` tee's log lines carry a prefix so the two lanes' output stays
// tellable-apart when interleaved in one terminal.
function localLog(msg: string): void {
  log(`[local] ${msg}`);
}

// Daemon log lines carry a local-time stamp: stdout.log is append-only across
// days, so an un-stamped "heartbeat error" is undatable after the fact. Only
// the watch lanes stamp — tables/help/interactive output stay clean.
function stamped(base: (msg: string) => void): (msg: string) => void {
  return (msg) => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    base(`${ts} ${msg}`);
  };
}

async function cmdWatch(): Promise<void> {
  const cfg = await ensureConfig();
  // --local: regular behavior untouched, PLUS a second fully independent lane
  // mirroring the same files to the local dev gateway — own token
  // (config.local.json), own offsets (state.local.json), own backoff. Both
  // lanes start concurrently so a large prod backlog can't delay the local
  // mirror (and vice versa); a dead dev stack only ever fails its own lane.
  const localCfg = hasFlag("local") ? await ensureLocalConfig() : null;
  const oneShot = process.argv.includes("--once") || process.argv.includes("-1");
  const only = flag("only");
  const [main, local] = await Promise.all([
    startWatch(cfg, { oneShot, only }, stamped(log)),
    localCfg ? startWatch(localCfg, { oneShot, only }, stamped(localLog)) : null,
  ]);
  if (!oneShot) {
    process.on("SIGINT", () => {
      log("\n[hx] stopping…");
      main.stop();
      local?.stop();
      process.exit(0);
    });
  }
}

async function cmdTick(): Promise<void> {
  const cfg = await ensureConfig();
  const localCfg = hasFlag("local") ? await ensureLocalConfig() : null;
  const only = flag("only");
  const r = await tickOnce(cfg, { only, oneShot: true }, log);
  log(`done. uploaded=${r.uploaded} failed=${r.failed}`);
  if (localCfg) {
    // The tee pass runs after the regular one (not concurrently) so a single
    // tick's output reads as two clean blocks instead of interleaved lines.
    const lr = await tickOnce(localCfg, { only, oneShot: true }, localLog);
    log(`[local] done. uploaded=${lr.uploaded} failed=${lr.failed}`);
  }
}

async function cmdBackfill(): Promise<void> {
  const cfg = await ensureConfig();
  log("[hx] backfilling tasks + plans for sessions already on disk…");
  const r = await backfillArtifacts(cfg, log);
  log(`done. tasks=${r.tasks} plans=${r.plans} failed=${r.failed}`);
}

// How long to wait on the gateway's /whoami lookup before giving up — used by
// the `hx status` header and the `hx connect` already-connected check. Generous
// enough for the gateway's own (bounded) identity round-trip, short enough not
// to stall either command.
const WHOAMI_TIMEOUT_MS = 6000;

interface WhoamiOk {
  ok: true;
  email: string | null;
  // The device's name as the gateway knows it. The approve page may have
  // (re)named the device, so this can differ from the cached cfg.deviceName.
  // null on gateways that predate the field.
  deviceName: string | null;
}
type WhoamiResult = WhoamiOk | { ok: false; unauthorized: boolean };

// Ask the gateway who this device token belongs to — the one authoritative
// "is this device still connected" probe: 401/403 means the token was revoked
// (e.g. disconnected from the workbench Devices page). Bounded, and the body is
// always drained so the undici socket is released and the process can exit —
// an undrained response keeps the event loop alive (the same trap that hung
// `hx disconnect`). The .json() success path drains too.
async function fetchWhoami(cfg: HxConfig): Promise<WhoamiResult> {
  // Never send the bearer token to a cleartext gateway (loopback excepted).
  assertSecureFetchUrl(cfg.gatewayBaseUrl, "hx whoami");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WHOAMI_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.gatewayBaseUrl}/whoami`, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      return { ok: false, unauthorized: res.status === 401 || res.status === 403 };
    }
    const body = (await res.json().catch(() => null)) as
      | { email?: string | null; deviceName?: string | null }
      | null;
    return {
      ok: true,
      email: typeof body?.email === "string" && body.email ? body.email : null,
      deviceName:
        typeof body?.deviceName === "string" && body.deviceName ? body.deviceName : null,
    };
  } catch {
    return { ok: false, unauthorized: false };
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the signed-in email for the status header. Prefer the value cached in
// config (instant, and works offline); otherwise ask the gateway's /whoami once
// and cache it. Best-effort throughout — any failure just means no email line,
// never a failed `hx status`.
async function resolveLoggedInEmail(cfg: HxConfig): Promise<string | null> {
  if (cfg.email) return cfg.email;
  const who = await fetchWhoami(cfg);
  if (!who.ok || !who.email) return null;
  // Cache it so later runs (including offline ones) show the line instantly.
  await writeConfig({ ...cfg, email: who.email });
  return who.email;
}

async function cmdStatus(): Promise<void> {
  const cfg = await readConfig();
  if (!cfg) {
    log("Connection: down — not connected (run `hx connect`)");
    return;
  }
  // Collect every status field as a [label, value] row, then render once as a
  // table. Column widths depend on every row, so nothing can be printed until
  // the (network) probe below has run and all rows are known.
  const rows: Array<[string, string]> = [];

  // Who this device is connected as — the first row, so the very first thing you
  // see is which account's sessions are being mirrored. Best-effort: resolved
  // from the gateway and cached in config, so it's omitted only when we can't
  // reach the gateway and have nothing cached yet.
  const email = await resolveLoggedInEmail(cfg);
  if (email) rows.push(["Logged in as", email]);

  // Where this device uploads to — the gateway it linked to at `hx connect`
  // (the let.ai-hosted URL, or a self-hosted workbench/Session-Vault URL).
  // Always shown, even when the connection is down, so a stale or wrong link
  // (e.g. a leftover localhost gateway) is easy to spot.
  rows.push(["Gateway", cfg.gatewayBaseUrl]);

  // The additive `--local` tee, when paired: where `hx watch --local` ALSO
  // mirrors sessions. Configuration only — no probe, so a dev stack that's
  // currently down can't slow `hx status` against the regular gateway.
  const localCfg = await readLocalConfig();
  if (localCfg?.accessToken) {
    rows.push(["Local tee", localCfg.gatewayBaseUrl]);
  }

  // Whether the background mirror is actually running — the thing `hx stop` /
  // `hx start` toggles. The Connection row below probes the network link from
  // THIS process and the Sync row reads local disk, so without this row a
  // stopped daemon was indistinguishable from a running one (`hx stop` then
  // `hx status` looked identical to before the stop). Placed above the probe
  // so it still shows when the gateway is unreachable.
  const ops = getDaemonOps();
  if (ops.managerName !== "none") {
    const ds = await ops.state().catch(() => null);
    if (ds) {
      rows.push([
        "Daemon",
        ds.pid
          ? `running (${ops.managerName}, pid ${ds.pid})`
          : ds.loaded
            ? `loaded, not running (${ops.managerName})`
            : "stopped — run `hx start` to resume",
      ]);
    }
  }

  // User-driven pause (settings.json — set from the HX Client UI). Shown
  // before the probe so a paused device explains its own backlog.
  const settings = await readSettings();
  if (isPaused(settings)) {
    const until = settings.pause?.untilMs;
    rows.push([
      "Paused",
      until ? `yes — resumes ${new Date(until).toLocaleString()}` : "yes — until resumed",
    ]);
  }

  // Local sync state remains useful even when the network probe is down: a
  // persisted destination hold should still name the affected org/repo.
  const report = await computeSyncReport().catch(() => null);
  const probe = await probeConnection(cfg);
  if (!probe.up) {
    rows.push(["Connection", `down — ${probe.reason}`]);
    if (report && report.skipped.length > 0) {
      rows.push(["Blocked", formatStatusBlocker(report.skipped)]);
      rows.push(["Details", "hx doctor sync"]);
    }
    printStatusTable(rows);
    return;
  }
  rows.push([
    "Connection",
    `up — ${probe.quality} (${probe.latencyMs} ms, ${formatRate(probe.bytesPerSec)})`,
  ]);

  // Catch-up progress: percentage first, then sessions, then the total size of
  // all sessions on disk.
  const snap = report?.snapshot ?? null;
  if (snap && snap.total > 0) {
    const size = formatSize(snap.totalBytes);
    rows.push([
      "Sync",
      snap.done >= snap.total
        ? `100% — ${snap.total} session${snap.total === 1 ? "" : "s"} · ${size}`
        // Floor, never round: a 199/200 backlog must read 99%, not a lying
        // "100%" next to an unfinished count.
        : `${Math.floor((snap.done / snap.total) * 100)}% — ${snap.done} / ${snap.total} sessions · ${size}`,
    ]);
  }
  // Sessions the bar can no longer see: their source file vanished (or left
  // the scan window) before the upload finished, so the server copy is
  // permanently partial. Without this row the status silently claims 100%.
  if (report && report.behind.length > 0) {
    // Classify each session ONCE: a session with both a deleted path and an
    // aged-out path counts as "deleted" (the stronger signal), never in both
    // buckets — otherwise the two counts could sum to more than the sessions.
    const goneSessions = new Set(
      report.behind.filter((b) => b.sourceGone).map((b) => b.sessionId),
    );
    const agedSessions = new Set<string>();
    for (const b of report.behind) {
      if (!b.sourceGone && !goneSessions.has(b.sessionId)) agedSessions.add(b.sessionId);
    }
    const parts: string[] = [];
    if (goneSessions.size > 0) {
      parts.push(`${goneSessions.size} partial on server (local file deleted)`);
    }
    if (agedSessions.size > 0) {
      parts.push(`${agedSessions.size} partial on server (last change over 30 days ago)`);
    }
    if (parts.length > 0) rows.push(["Sync gaps", parts.join("; ")]);
  }
  // Sessions paused on a temporarily-unavailable store. Transient (they resume
  // on their own), so this is a distinct, softer signal from the "Sync gaps"
  // above — the upload isn't lost, it's waiting and retrying.
  if (report && report.skipped.length > 0) {
    rows.push(["Blocked", formatStatusBlocker(report.skipped)]);
    rows.push(["Details", "hx doctor sync"]);
  }
  printStatusTable(rows);
}

async function cmdDoctor(): Promise<void> {
  if (process.argv[3] !== "sync") {
    log("usage: hx doctor sync [--json]");
    process.exitCode = 64;
    return;
  }
  const cfg = await ensureConfig();
  const report = await computeSyncReport();
  const doctor = buildSyncDoctorReport(report, cfg.gatewayBaseUrl);
  if (hasFlag("json")) log(JSON.stringify(doctor, null, 2));
  else log(formatSyncDoctorText(doctor));
  if (!doctor.ok) process.exitCode = 1;
}

async function cmdRetry(): Promise<void> {
  if (!hasFlag("blocked")) {
    log("usage: hx retry --blocked");
    process.exitCode = 64;
    return;
  }
  const cfg = await ensureConfig();
  const report = await computeSyncReport();
  if (report.skipped.length === 0) {
    log("No blocked sessions to retry.");
    return;
  }

  // state.json has a single-writer contract; retryBlocked() stops an installed
  // daemon before mutating its backoffs and brings the same service back. A
  // deliberately-stopped client gets one foreground retry pass but remains
  // stopped afterward.
  const ops = getDaemonOps();
  const before = await ops.state().catch(() => ({ loaded: false, pid: null }));
  const dotfileConsent = before.loaded ? await resolveDotfileConsent(ops) : "denied";
  const r = await retryBlocked(cfg, { dotfileConsent, log });
  if (r.restarted) {
    log(
      `Released ${r.sessions} blocked session${r.sessions === 1 ? "" : "s"}; daemon restarted for an immediate retry.`,
    );
  } else {
    log(`Released ${r.sessions} blocked session${r.sessions === 1 ? "" : "s"}; ran one retry pass now.`);
    if (r.pass) log(`Retry pass complete. uploaded=${r.pass.uploaded} failed=${r.pass.failed}`);
  }
  log("Check the result with `hx status`.");
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// Render the status fields. On a TTY: a bordered two-column box (Unicode glyphs
// on a UTF-8 locale, ASCII otherwise) with a dimmed frame so the eye lands on
// the values. When piped/redirected: aligned "Label: value" lines with no
// box-drawing characters, so the output stays grep-friendly. Columns size to
// content; .length / .padEnd are exact here because every glyph in the values
// (—, ·, the box characters) is a single UTF-16 code unit.
function printStatusTable(rows: Array<[string, string]>): void {
  if (rows.length === 0) return;
  const labelW = Math.max(...rows.map(([k]) => k.length));

  if (!process.stdout.isTTY) {
    for (const [k, v] of rows) log(`${`${k}:`.padEnd(labelW + 1)} ${v}`);
    return;
  }

  const valueW = Math.max(...rows.map(([, v]) => v.length));
  const utf8 = /utf-?8/i.test(
    process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "",
  );
  const g = utf8
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", dn: "┬", up: "┴", lt: "├", rt: "┤", x: "┼" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", dn: "+", up: "+", lt: "+", rt: "+", x: "+" };
  const dim = "\x1b[2m";
  const rst = "\x1b[0m";
  const rule = (l: string, mid: string, r: string): string =>
    `${dim}${l}${g.h.repeat(labelW + 2)}${mid}${g.h.repeat(valueW + 2)}${r}${rst}`;
  const bar = `${dim}${g.v}${rst}`;

  log(rule(g.tl, g.dn, g.tr));
  rows.forEach(([k, v], i) => {
    if (i > 0) log(rule(g.lt, g.x, g.rt)); // horizontal rule between every row
    log(`${bar} ${k.padEnd(labelW)} ${bar} ${v.padEnd(valueW)} ${bar}`);
  });
  log(rule(g.bl, g.up, g.br));
}

// `hx disconnect` tells the gateway to revoke this device, but it's best-effort
// (see below) — cap the wait so a slow or saturated gateway can't strand it.
const DISCONNECT_TIMEOUT_MS = 8000;

async function cmdDisconnect(): Promise<void> {
  // `hx disconnect --local` tears down only the tee lane, mirroring
  // `hx connect --local` — the main connection (and daemon) keep running.
  if (hasFlag("local")) return cmdDisconnectLocal();
  // Server-side revoke is best-effort (a network failure shouldn't strand the
  // user); the local token is cleared regardless, and ~/.let/hx/device-id is
  // left in place so a later `hx connect` restores the sessions.
  const disconnected = await disconnectDevice(await readConfig());
  log(disconnected ? "Disconnected." : "Was not connected.");
}

// Tear down the `--local` tee: best-effort revoke against the local dev
// gateway (same bounded + drained idiom as the main disconnect), then drop
// config.local.json entirely — unlike the main config there's no seeded URL
// worth preserving, `hx connect --local` always knows where the dev gateway
// lives. state.local.json stays, so a reconnect resumes instead of
// re-uploading history.
async function cmdDisconnectLocal(): Promise<void> {
  const cfg = await readLocalConfig();
  if (!cfg?.accessToken) {
    log("Local tee was not connected.");
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISCONNECT_TIMEOUT_MS);
  try {
    // Best-effort notify, but never leak the token over cleartext (loopback ok).
    assertSecureFetchUrl(cfg.gatewayBaseUrl, "hx disconnect");
    const res = await fetch(`${cfg.gatewayBaseUrl}/devices/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: ctrl.signal,
    });
    await res.arrayBuffer(); // release the socket so the process can exit
  } catch {
    // ignore — best-effort; a downed dev stack mustn't strand the teardown
  } finally {
    clearTimeout(timer);
  }
  await unlink(localConfigPath()).catch(() => {});
  log("Local tee disconnected.");
}

async function cmdStart(): Promise<void> {
  // The daemon runs `hx watch`, which reads the gateway from config.json and
  // uploads with the saved token — so refuse to install a service that has
  // nothing to mirror. (The daemon mirrors the MAIN lane only: the --local
  // tee is a foreground `hx watch --local` / `hx tick --local` affair, since
  // a flag on `hx start` wouldn't reach the background process.)
  await ensureConfig();
  const ops = getDaemonOps();
  const binPath = process.execPath;
  const dotfileConsent = await resolveDotfileConsent(ops);
  await ops.install({ binPath, dotfileConsent });
  const ds = await ops.state();
  reportStarted(ops, ds, dotfileConsent);
  log(`logs:   hx logs`);
  log(`status: hx status`);
}

async function cmdStop(): Promise<void> {
  const ops = getDaemonOps();
  // stop() verifies the service is actually gone (and throws if it survived),
  // so this success line can't lie about a daemon that's still running.
  const { wasRunning } = await ops.stop();
  if (wasRunning) {
    log(`hx stopped (${ops.managerName}). Run \`hx start\` to resume.`);
  } else {
    log(`hx is not running — nothing to stop. Run \`hx start\` to start it.`);
  }
}

async function cmdRestart(): Promise<void> {
  await ensureConfig();
  const ops = getDaemonOps();
  const binPath = process.execPath;
  const dotfileConsent = await resolveDotfileConsent(ops);
  await ops.install({ binPath, dotfileConsent });
  log(`hx restarted (${ops.managerName}).`);
}

async function cmdLogs(): Promise<void> {
  const lines = Number(flag("lines", "50"));
  await tailLogs(Number.isFinite(lines) && lines >= 0 ? lines : 50);
}

async function cmdUpdate(): Promise<void> {
  // `hx update` fetches the new binary through `${gatewayBaseUrl}/download/...`,
  // and that download proxy is unauthenticated — so update must work whether or
  // not this device is connected. Someone stuck on a too-old binary, or who has
  // run `hx disconnect`, still needs to pull the latest; disconnect deliberately
  // keeps the gateway URL in config.json precisely so this keeps working. We
  // DON'T require a token (`ensureConfig`), only a gateway: --local or the
  // saved config — with no silent localhost default to mask a missing one.
  const gatewayBaseUrl = await requireGatewayUrl();

  // Animated download bar matching the `curl … | sh` installer. runUpdate emits
  // phase/percent ticks; we render them on stderr (so the stdout summary below
  // stays pipe-clean) as Downloading → Unpacking → Verifying. On a non-TTY each
  // phase prints one plain breadcrumb instead — no carriage-return cruft.
  const bar = new ProgressBar();
  const LABEL: Record<UpdateProgress["phase"], string> = {
    download: "Downloading",
    unpack: "Unpacking",
    verify: "Verifying",
  };
  const CRUMB: Record<UpdateProgress["phase"], string> = {
    download: "Downloading hx…",
    unpack: "Unpacking…",
    verify: "Verifying…",
  };
  const seen = new Set<UpdateProgress["phase"]>();
  let pulseFrame = 0;
  let barClosed = false;
  const onProgress = (ev: UpdateProgress): void => {
    if (seen.size === 0) bar.hideCursor();
    if (!seen.has(ev.phase)) {
      seen.add(ev.phase);
      bar.status(CRUMB[ev.phase]); // non-TTY breadcrumb; no-op on a TTY
    }
    if (ev.phase === "download" && (!ev.total || ev.total <= 0)) {
      bar.pulse(LABEL[ev.phase], pulseFrame++);
    } else {
      bar.draw(ev.pct, LABEL[ev.phase]);
    }
    // Verify hitting 100% is the final tick. Close the bar line now —
    // runUpdate next writes its "installed → …" summary to stdout, and the
    // open (newline-less) bar line on stderr would otherwise collide with it.
    if (ev.phase === "verify" && ev.pct >= 100) {
      bar.end();
      bar.showCursor();
      barClosed = true;
    }
  };

  let r: UpdateResult;
  try {
    r = await runUpdate({ log, gatewayBaseUrl, onProgress });
  } catch (err) {
    if (seen.size > 0 && !barClosed) bar.clearLine(); // wipe a half-drawn bar
    throw err;
  } finally {
    bar.showCursor(); // safety net — no-op if already shown / never hidden
  }

  if (r.alreadyLatest) {
    log(`hx is already on the latest version (v${r.localVersion}). Nothing to do. 🎉`);
    return;
  }
  const shaNote = r.sha256 ? `, sha256 ${r.sha256.slice(0, 12)}…` : "";
  log(`hx updated to latest (${r.asset}${shaNote}).`);
  if (r.daemonRestarted) {
    log(`daemon restarted.`);
  }
  // Echo the now-installed version as the last line. This process is still the
  // old binary, so prefer the remote version we resolved over its own constant.
  log(`hx version: ${r.remoteVersion ?? r.localVersion}`);
}

async function cmdUninstall(): Promise<void> {
  const purge = hasFlag("purge");
  const r = await runUninstall({ purge, log });
  log("");
  log(`hx uninstalled.`);
  log(`  daemon removed: ${r.daemonRemoved ? "yes" : "no (or wasn't loaded)"}`);
  log(`  binary removed: ${r.binaryRemoved ? r.binaryPath : "no (not found)"}`);
  log(`  config purged:  ${r.configPurged ? "yes" : purge ? "no (HX dir not found)" : "skipped — pass --purge to also remove ~/.let/hx/"}`);
  log("");
  log(`If you'd like to clean up your shell-rc PATH entry, look for the`);
  log(`"Added by hx installer" line and remove it.`);
}

const UI_DEFAULT_PORT = 8000;
const UI_PORT_SCAN_SPAN = 20;

// One line under the launch URL. The TTL applies to OPENING the link — once
// open, the tab stays signed in until the server stops. Derived from the auth
// TTL so the message can't drift from the real value.
function launchLinkNote(): string {
  const h = LAUNCH_TTL_MS / 3_600_000;
  const ttl = h >= 1 && Number.isInteger(h) ? `${h}h` : `${Math.round(LAUNCH_TTL_MS / 60_000)} min`;
  return `[hx]   open this link within ${ttl} to sign in; once open, the tab stays signed in until you stop hx ui`;
}

async function cmdUi(): Promise<void> {
  const portFlag = flag("port");
  let requested: number | null = null;
  if (portFlag !== undefined) {
    requested = Number(portFlag);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      log(`invalid --port: ${portFlag}`);
      process.exitCode = 64;
      return;
    }
  }

  const assets = await loadUiAssets();
  if (!assets) {
    log("The web UI isn't bundled in this build and ui/dist doesn't exist.");
    log("From a source checkout, build it once: bun run build:ui");
    process.exit(1);
  }

  const auth = createUiAuth();
  const strict = requested !== null;
  const basePort = requested ?? UI_DEFAULT_PORT;

  const providers: UiProviders = {
    snapshot: () => buildSnapshot(),
    sessions: (folderId) => buildSessions(folderId),
    preview: async (filePath) =>
      (await isDiscoveredPath(filePath)) ? previewSessionFile(filePath) : null,
    logs: (maxLines) => tailDaemonLog(maxLines),
    activity: (hours) => activitySince(hours),
    probe: async () => {
      const cfg = await readConfigForProbe();
      if (!cfg) return { up: false, reason: "not connected" };
      return probeConnection(cfg);
    },
    whoami: () => cachedWhoami(),
  };

  const events = createEventHub();
  let updateRunning = false;
  const actions: UiActions = {
    readSettings: () => readSettings(),
    writeSettings: (patch) => writeSettings(patch as Partial<HxSettings>),
    // A browser click must not edit dotfiles, so the container backend starts
    // without restart persistence — the CLI path (`hx start`) covers that.
    daemon: (action) => daemonAction(action, "denied"),
    retryBlocked: async () => {
      const cfg = await readConfig();
      if (!cfg?.accessToken) return { sessions: 0, files: 0, restarted: false };
      return retryBlocked(cfg, { dotfileConsent: "denied", log });
    },
    updateCheck: async () => {
      const cfg = await readConfig();
      if (!cfg?.gatewayBaseUrl) {
        return { current: HX_VERSION, latest: null, updateAvailable: false };
      }
      return checkForUpdate(cfg.gatewayBaseUrl);
    },
    startUpdate: async () => {
      if (updateRunning) return false;
      const cfg = await readConfig();
      if (!cfg?.gatewayBaseUrl) {
        events.emit({ type: "update-error", message: "not connected to a gateway" });
        return true;
      }
      updateRunning = true;
      void runUpdate({
        gatewayBaseUrl: cfg.gatewayBaseUrl,
        log,
        onProgress: (ev) => events.emit({ type: "update-progress", ...ev }),
      })
        .then((r) =>
          events.emit({
            type: "update-done",
            alreadyLatest: r.alreadyLatest ?? false,
            version: r.remoteVersion ?? r.localVersion,
            daemonRestarted: r.daemonRestarted,
          }),
        )
        .catch((err) => events.emit({ type: "update-error", message: (err as Error).message }))
        .finally(() => {
          updateRunning = false;
        });
      return true;
    },
    disconnect: async () => ({ disconnected: await disconnectDevice(await readConfig()) }),
  };

  let port = basePort;
  let server = tryServeUi(basePort, auth, assets, providers, actions, events);
  if (!server && !strict) {
    // The default port is taken — maybe by an earlier `hx ui`. Reuse a live
    // instance of ours instead of racing it; otherwise scan forward.
    const existing = await readServerInfo();
    if (existing) {
      const alive = await probeExistingInstance(existing);
      if (alive) {
        log(`[hx] HX Client UI already running at ${alive.url}`);
        log(launchLinkNote());
        if (!hasFlag("no-open")) openBrowser(alive.url);
        return;
      }
      await removeServerInfo();
    }
    for (let p = basePort + 1; p <= basePort + UI_PORT_SCAN_SPAN && !server; p++) {
      server = tryServeUi(p, auth, assets, providers, actions, events);
      if (server) port = p;
    }
    if (server) {
      log(`[hx] port ${basePort} is in use by another app — serving on http://localhost:${port}`);
    }
  }
  if (!server) {
    const range = strict ? `${basePort}` : `${basePort}-${basePort + UI_PORT_SCAN_SPAN}`;
    log(`port ${range} is in use — stop the other process or pass --port <n> (try: lsof -i :${basePort})`);
    process.exit(1);
  }

  // Only the ownerKey is persisted (0600) — never a launch token. It proves
  // same-uid ownership for the reuse handshake; launch tokens are minted fresh,
  // single-use, and short-lived, so a leaked one (browser-opener argv) can't be
  // replayed.
  await writeServerInfo({ port, pid: process.pid, ownerKey: auth.ownerKey });

  // Nudge connected browsers when anything under ~/.let/hx changes (state,
  // settings, journal, logs — all live there). Directory-level watch: the
  // daemon's atomic tmp+rename writes would silently detach a file watch.
  // Throttled so the 1.5 s tick cadence doesn't turn into a refetch storm.
  const CHANGE_NUDGE_MIN_MS = 1_500;
  let lastNudgeMs = 0;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    watchDir(HX_DIR, { persistent: false }, () => {
      const now = Date.now();
      if (now - lastNudgeMs >= CHANGE_NUDGE_MIN_MS) {
        lastNudgeMs = now;
        events.emit({ type: "changed" });
      } else if (!nudgeTimer) {
        nudgeTimer = setTimeout(() => {
          nudgeTimer = null;
          lastNudgeMs = Date.now();
          events.emit({ type: "changed" });
        }, CHANGE_NUDGE_MIN_MS);
      }
    });
  } catch {
    // no watcher — the UI's polling still keeps things fresh
  }

  const launchUrl = `http://localhost:${port}/#k=${auth.mintLaunchToken()}`;
  log(`[hx] HX Client UI → ${launchUrl}`);
  log(launchLinkNote());
  if (assets.mode === "disk") log(`[hx] serving ui/dist from disk (source checkout)`);
  log(`[hx] Ctrl+C to stop`);
  if (!hasFlag("no-open")) openBrowser(launchUrl);

  const shutdown = (): void => {
    void removeServerInfo().finally(() => {
      server.stop(true);
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "--version":
    case "-v":
    case "version":
      log(versionLine());
      break;
    case "connect":
    case "login": // pre-2026-05-28 alias; keep working for old install.sh / docs
      await cmdConnect();
      break;
    case "watch":
      await cmdWatch();
      break;
    case "tick":
      await cmdTick();
      break;
    case "backfill":
      await cmdBackfill();
      break;
    case "status":
      await cmdStatus();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "retry":
      await cmdRetry();
      break;
    case "disconnect":
    case "logout": // pre-2026-05-28 alias; keep working for old docs / muscle memory
      await cmdDisconnect();
      break;
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "logs":
      await cmdLogs();
      break;
    case "ui":
      await cmdUi();
      break;
    case "update":
      await cmdUpdate();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      log("hx — laptop daemon for hx-vision");
      log("");
      log("Setup:");
      log("  connect    Approve this device + start the background mirror");
      log("  start      Install + run as a background service (run by connect)");
      log("  stop       Pause the background service");
      log("  restart    Reload + restart the background service");
      log("  status     Show connection status and link quality");
      log("  doctor sync  Explain blocked sessions (pass --json for automation)");
      log("  logs       Tail the daemon's stdout / stderr");
      log("  ui         Open the local HX Client UI (http://localhost:8000; --port, --no-open)");
      log("");
      log("Maintenance:");
      log("  backfill   Upload tasks + plans for sessions already on disk");
      log("  retry --blocked  Clear destination backoff and retry immediately");
      log("  update     Fetch the latest hx binary and restart the daemon");
      log("  disconnect Forget the device token");
      log("  uninstall  Remove daemon + binary (pass --purge to also remove ~/.let/hx/)");
      log("");
      log("Foreground (debug):");
      log("  watch      Run the mirror in this terminal (Ctrl+C to stop)");
      log("  tick       Run a single upload pass and exit");
      log("");
      log("  --local    connect/watch/tick: ALSO mirror sessions to the local dev");
      log("             gateway (http://localhost:9000); update: fetch from it");
      log("  --version  Print hx version");
      break;
    default:
      log(`unknown command: ${cmd}`);
      log(`run \`hx help\` for the full list.`);
      process.exit(64);
  }
}

void main().catch((err) => {
  log(`error: ${(err as Error).message}`);
  process.exit(1);
});

// `writeConfig` is re-exported to keep the symbol reachable for tests/scripts
// that import the CLI's entry module.
export { writeConfig };
