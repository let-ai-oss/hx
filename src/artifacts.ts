// Reads the two local sidecar artifacts that live next to a Claude Code
// session but NOT inside its jsonl:
//   • tasks — ~/.claude/tasks/<sessionId>/<n>.json  (one file per task)
//   • plan  — ~/.claude/plans/<slug>.md, referenced by a plan_mode /
//             plan_mode_exit attachment event inside the session jsonl
//
// Both are whole small files rewritten in place, so the watcher uploads them
// wholesale (hash-gated) rather than via the transcript's append/compose path.

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const TASKS_DIR = path.join(HOME, ".claude", "tasks");

export interface RawTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string | null;
  status: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown> | null;
}

export interface PlanArtifact {
  planFilePath: string;
  content: string;
}

export function hashContent(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/**
 * Read ~/.claude/tasks/<sessionId>/*.json into a normalized task list.
 * Returns null when the session has no tasks dir; [] when the dir exists but
 * is empty. Files are sorted by numeric id so they read in creation order.
 */
export async function readTaskSet(sessionId: string): Promise<RawTask[] | null> {
  const dir = path.join(TASKS_DIR, sessionId);
  let entries: string[];
  try {
    const dstat = await stat(dir);
    if (!dstat.isDirectory()) return null;
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonFiles = entries
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => {
      const an = parseInt(a, 10);
      const bn = parseInt(b, 10);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.localeCompare(b);
    });
  const tasks: RawTask[] = [];
  for (const f of jsonFiles) {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    tasks.push({
      id: String(d.id ?? f.replace(/\.json$/, "")),
      subject: typeof d.subject === "string" ? d.subject : "",
      description: typeof d.description === "string" ? d.description : "",
      activeForm: typeof d.activeForm === "string" ? d.activeForm : null,
      status: typeof d.status === "string" ? d.status : "pending",
      blocks: Array.isArray(d.blocks) ? d.blocks.map(String) : [],
      blockedBy: Array.isArray(d.blockedBy) ? d.blockedBy.map(String) : [],
      metadata: d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>) : null,
    });
  }
  return tasks;
}

/**
 * Scan a block of jsonl text for the LAST plan_mode / plan_mode_exit
 * attachment and return the referenced plan file path. Cheap quick-reject so
 * we only JSON.parse candidate lines. Used on each fresh chunk by the watcher.
 */
export function findPlanPathInText(text: string): string | null {
  let planFilePath: string | null = null;
  for (const line of text.split("\n")) {
    if (!line || !line.includes("plan_mode")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.type !== "attachment") continue;
    const a = d.attachment as Record<string, unknown> | undefined;
    if (!a) continue;
    if (a.type !== "plan_mode" && a.type !== "plan_mode_exit") continue;
    if (typeof a.planFilePath === "string" && a.planFilePath) planFilePath = a.planFilePath;
  }
  return planFilePath;
}

/** Read a plan markdown file off disk, or null if it's gone. */
export async function readPlanFile(planFilePath: string): Promise<PlanArtifact | null> {
  try {
    const st = await stat(planFilePath);
    if (!st.isFile()) return null;
    const content = await readFile(planFilePath, "utf8");
    return { planFilePath, content };
  } catch {
    return null;
  }
}

/** Whole-file variant for backfill: scan an entire jsonl for the plan path. */
export async function readPlanForJsonl(jsonlPath: string): Promise<PlanArtifact | null> {
  let text: string;
  try {
    text = await readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const planFilePath = findPlanPathInText(text);
  if (!planFilePath) return null;
  return readPlanFile(planFilePath);
}

/** All session ids that have a ~/.claude/tasks/<id>/ dir — drives backfill. */
export async function listTaskSessionIds(): Promise<string[]> {
  try {
    const entries = await readdir(TASKS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ── Child-lane meta sidecars + agent-team configs ───────────────────────────

/** agent-<id>.meta.json next to a child transcript. Two shapes observed:
 *  subagents carry {agentType, description, toolUseId}; workflow agents carry
 *  {agentType: "workflow-subagent", worktreePath}. All fields best-effort. */
export interface AgentMetaSidecar {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  worktreePath: string | null;
}

export async function readAgentMeta(metaPath: string | null): Promise<AgentMetaSidecar | null> {
  if (!metaPath) return null;
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return {
      agentType: typeof d.agentType === "string" ? d.agentType : null,
      description: typeof d.description === "string" ? d.description : null,
      toolUseId: typeof d.toolUseId === "string" ? d.toolUseId : null,
      worktreePath: typeof d.worktreePath === "string" ? d.worktreePath : null,
    };
  } catch {
    return null;
  }
}

/** Read a small text file, or null. Used for workflow scripts + journals. */
export async function readTextFile(p: string | null, maxBytes = 500_000): Promise<string | null> {
  if (!p) return null;
  try {
    const st = await stat(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

const TEAMS_DIR = path.join(HOME, ".claude", "teams");

export interface TeamConfig {
  name: string;
  config: unknown;
}

/** ~/.claude/teams/<name>/config.json for every active team (the dir exists
 *  only while a team runs — empty result is the steady state). */
export async function readTeamConfigs(): Promise<TeamConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(TEAMS_DIR);
  } catch {
    return [];
  }
  const out: TeamConfig[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const raw = await readTextFile(path.join(TEAMS_DIR, name, "config.json"));
    if (!raw) continue;
    try {
      out.push({ name, config: JSON.parse(raw) });
    } catch {
      /* unreadable config — skip the team */
    }
  }
  return out;
}
