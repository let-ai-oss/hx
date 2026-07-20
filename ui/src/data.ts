// All demo data, exactly as in the prototype. Nothing here talks to a backend —
// a separate engineer wires this to the real hx client later.

export type DestKind = "fortress" | "cloud";
export type VisKind = "team" | "me";

export interface Folder {
  id: string;
  tool: string;
  path: string;
  sessions: number;
  repo: string | null;
  project?: string;
  company?: string;
  noProject?: boolean;
  dest: string;
  destKind: DestKind;
  vis: string;
  visKind: VisKind;
  personal: boolean;
  shared?: boolean;
}

export const FOLDERS: Folder[] = [
  { id: "squeeze-cli", tool: "Claude Code CLI", path: "/workspace/squeeze", sessions: 132,
    repo: "orange-corp/squeeze", project: "Squeeze", company: "orange-corp",
    dest: "Orange Corp fortress", destKind: "fortress", vis: "Me + Payments team (3)", visKind: "team", personal: false, shared: true },
  { id: "pulp", tool: "Claude Code CLI", path: "/workspace/pulp", sessions: 41,
    repo: "orange-corp/pulp", project: "Squeeze", company: "orange-corp",
    dest: "Orange Corp fortress", destKind: "fortress", vis: "Only me", visKind: "me", personal: false },
  { id: "zest", tool: "Claude Code CLI", path: "/workspace/zest-monitor", sessions: 87,
    repo: "orange-corp/zest-monitor", project: "Zest Monitor", company: "orange-corp",
    dest: "Orange Corp fortress", destKind: "fortress", vis: "Only me", visKind: "me", personal: false },
  { id: "rind", tool: "Claude Code CLI", path: "/workspace/rind", sessions: 12,
    repo: "orange-corp/rind", noProject: true,
    dest: "My let.ai space", destKind: "cloud", vis: "Only me", visKind: "me", personal: true },
  { id: "notes", tool: "Claude Code CLI", path: "~/notes", sessions: 5,
    repo: null, dest: "My let.ai space", destKind: "cloud", vis: "Only me", visKind: "me", personal: true },
  { id: "qr", tool: "Claude Code Desktop", path: "~/work/quarterly-review", sessions: 3,
    repo: null, dest: "My let.ai space", destKind: "cloud", vis: "Only me", visKind: "me", personal: true },
  { id: "squeeze-ccd", tool: "Claude Code Desktop", path: "/workspace/squeeze", sessions: 6,
    repo: "orange-corp/squeeze", project: "Squeeze", company: "orange-corp",
    dest: "Orange Corp fortress", destKind: "fortress", vis: "Me + Payments team (3)", visKind: "team", personal: false, shared: true },
  { id: "nbrisk", tool: "Codex CLI", path: "/workspace/nb-risk", sessions: 9,
    repo: "nordbank/risk-models", project: "Risk Models", company: "nordbank",
    dest: "Nordbank fortress", destKind: "fortress", vis: "Only me", visKind: "me", personal: false },
  { id: "pricing", tool: "Codex CLI", path: "~/experiments/pricing-sim", sessions: 7,
    repo: null, dest: "My let.ai space", destKind: "cloud", vis: "Only me", visKind: "me", personal: true },
];

export const TOOL_ORDER = ["Claude Code CLI", "Claude Code Desktop", "Codex CLI", "Codex Desktop"];
export const TOOL_NOTE: Record<string, string> = { "Claude Code CLI": "~/.claude/projects", "Codex CLI": "~/.codex/sessions" };

// The product name is brandable — swap once, rebrand everywhere.
export const FORTRESS_BRAND = "HX Fortress";
export const DEST_LABEL: Record<string, string> = {
  "Orange Corp fortress": `Orange Corp | ${FORTRESS_BRAND}`,
  "Nordbank fortress": `Nordbank | ${FORTRESS_BRAND}`,
  "My let.ai space": `let.ai | ${FORTRESS_BRAND}`,
};
export const destLabel = (d: string) => DEST_LABEL[d] ?? d;

export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many || one + "s")}`;

export interface Fortress {
  id: string;
  name: string;
  destMatch: string;
  personal?: boolean;
  sub: string;
  pill: [string, string];
  quality: string;
  last: string;
  bytes: string;
  offsets: string;
}

export const FORTRESSES: Fortress[] = [
  { id: "orange", name: "Orange Corp | HX Fortress", destMatch: "Orange Corp fortress",
    sub: "run by orange-corp on its own servers",
    pill: ["ok", "Connected"], quality: "Excellent — 26 ms", last: "12s ago", bytes: "41.2 MB",
    offsets: "All offsets match — every uploaded byte verified against this fortress." },
  { id: "nordbank", name: "Nordbank | HX Fortress", destMatch: "Nordbank fortress",
    sub: "run by nordbank on its own servers",
    pill: ["warn", "Idle — retrying"], quality: "Unreachable since 16:02", last: "2h ago", bytes: "0.8 MB",
    offsets: "Retrying with backoff — nothing is lost; queued sessions send on reconnect." },
  { id: "letai", name: "let.ai | HX Fortress", destMatch: "My let.ai space", personal: true,
    sub: "my private space — only I can ever see it",
    pill: ["ok", "Connected"], quality: "Excellent — 26 ms", last: "40s ago", bytes: "3.1 MB",
    offsets: "All offsets match — every uploaded byte verified against this fortress." },
];

export interface InspectItem {
  id: string;
  title: string;
  status: string;
  size: string;
  dest: string;
  kind: DestKind;
  lines: [string, string][];
}

export const INSPECT: InspectItem[] = [
  { id: "i1", title: "Fix S3 routing gates", status: "waiting to send", size: "184 KB", dest: "Orange Corp fortress", kind: "fortress",
    lines: [
      ["Me", "why does our hx client report up/connected if there was a socket error?"],
      ["Agent", "The status row runs a fresh probe when you ask — the heartbeat error was one transient failed request from an earlier run…"],
      ["Tool", "read_file  hx/src/probe.ts  (203 lines)"],
      ["Agent", "probeConnection() takes 3 latency samples and one 1 MiB timed download, then grades the weakest of the two…"],
      ["Me", "ok — and the S3 bucket behind our HX Fortress is empty, how can this be?"],
    ] },
  { id: "i2", title: "Refactor probe grading", status: "waiting to send", size: "61 KB", dest: "My let.ai space", kind: "cloud",
    lines: [
      ["Me", "make the grade() thresholds configurable"],
      ["Agent", "Reading probe.ts… the thresholds are inline constants; I’ll lift them into a config object…"],
      ["Tool", "edit_file  hx/src/probe.ts  (+18 −6)"],
    ] },
  { id: "i3", title: "Squeeze onboarding flow", status: "sent 16:31", size: "402 KB", dest: "Orange Corp fortress", kind: "fortress",
    lines: [
      ["Me", "walk the onboarding wizard and fix the step-2 validation"],
      ["Agent", "Booting the dev stack and opening /onboarding…"],
      ["Tool", "playwright  screenshot  onboarding-step2.png"],
    ] },
  { id: "i4", title: "Zest alert thresholds", status: "sent 15:58", size: "510 KB", dest: "Orange Corp fortress", kind: "fortress",
    lines: [["Me", "tighten the zest-monitor position alert"], ["Agent", "Reading the monitor config…"]] },
  { id: "i5", title: "Notes — travel plan", status: "sent 15:44", size: "18 KB", dest: "My let.ai space", kind: "cloud",
    lines: [["Me", "outline a 3-day Stockholm plan"], ["Agent", "Day 1: Gamla Stan…"]] },
  { id: "i6", title: "Risk model backtest", status: "sent 14:20", size: "96 KB", dest: "Nordbank fortress", kind: "fortress",
    lines: [["Me", "rerun the backtest with 2025 rates"], ["Tool", "run  make backtest YEAR=2025"]] },
  { id: "i7", title: "Pricing sim sweep", status: "sent 13:02", size: "44 KB", dest: "My let.ai space", kind: "cloud",
    lines: [["Me", "sweep elasticity 0.2–0.8"], ["Agent", "Running 7 scenarios…"]] },
];

// [hour, MB, sessions]
export const HOURS: [number, number, number][] = [
  [0, .15, 1], [1, .1, 1], [2, .08, 0], [3, .06, 0], [4, .06, 0], [5, .08, 0], [6, .12, 1], [7, .28, 1],
  [8, .64, 2], [9, 1.16, 3], [10, 1.48, 3], [11, .82, 2], [12, .72, 2], [13, 1.32, 3], [14, 1.76, 4],
  [15, .94, 2], [16, .58, 2], [17, .36, 1], [18, .18, 1], [19, .12, 0], [20, .22, 1], [21, .5, 1], [22, 1.04, 2], [23, .76, 2],
];
export const MAX_MB = 2;

// Sent rows: [time, plain-prefix, bold-title ("" = no bold part), pill kind, dest key, size]
export type SentRow = [string, string, string, string, string, string];
export const SENT: SentRow[] = [
  ["16:42", "Sent an update for ", "“Fix S3 routing gates”", "fortress", "Orange Corp fortress", "184 KB"],
  ["16:41", "Sent an update for ", "“Refactor probe grading”", "cloud", "My let.ai space", "61 KB"],
  ["16:31", "Sent an update for ", "“Squeeze onboarding flow”", "fortress", "Orange Corp fortress", "402 KB"],
  ["16:30", "Storage check passed — a test write landed and was read back", "", "ok", "Orange Corp fortress", "2 KB"],
];
export const EARLIER: SentRow[] = [
  ["15:58", "Sent an update for ", "“Zest alert thresholds”", "fortress", "Orange Corp fortress", "510 KB"],
  ["15:44", "Sent an update for ", "“Notes — travel plan”", "cloud", "My let.ai space", "18 KB"],
  ["14:20", "Sent an update for ", "“Risk model backtest”", "fortress", "Nordbank fortress", "96 KB"],
];

export type LogLevel = "info" | "up" | "warn";
export interface LogLine { ts: string; body: string; level: LogLevel; }
// body strings keep the prototype's exact spacing — the pane is pre-wrap.
export const LOG_LINES: LogLine[] = [
  { ts: "16:44:03", body: " [hx] tick uploaded=3 failed=0", level: "info" },
  { ts: "16:44:02", body: "   projects/-workspace-squeeze/0731fa4a….jsonl (+184,201B → orange-corp, claude-cli, 0731fa4a…)", level: "up" },
  { ts: "16:44:01", body: "   [agent] 0731fa4a…/a47abc8c… (+95,665B)", level: "up" },
  { ts: "16:41:56", body: "   projects/-home-johnny-notes/9d445a79….jsonl (+61,004B → my let.ai space, claude-cli, 9d445a79…)", level: "up" },
  { ts: "16:40:00", body: " [groups] synced 2 CCD group(s)", level: "info" },
  { ts: "16:12:41", body: " [hx] heartbeat error: the connection closed mid-request — retrying at the next beat", level: "warn" },
  { ts: "16:12:41", body: " [hx] poll interval 1500ms; gateway (via let.ai)", level: "info" },
  { ts: "16:02:07", body: " [hx] destination nordbank unavailable (503); will retry", level: "info" },
  { ts: "16:02:07", body: " [hx] uploads to nordbank not progressing; backing off 20s", level: "warn" },
  { ts: "15:58:44", body: "   projects/-workspace-zest-monitor/f480c87e….jsonl (+509,558B → orange-corp, claude-cli, f480c87e…)", level: "up" },
  { ts: "15:30:00", body: " [hx] canonical audit: all sessions match — nothing to heal", level: "info" },
  { ts: "09:02:11", body: " [hx] watching ~/.claude/projects, ~/.codex/sessions, ~/.codex/archived_sessions", level: "info" },
];
