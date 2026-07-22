// Static labels shared across views. All session/folder/destination DATA is
// live — fetched from the local hx ui server (see api.ts / store.tsx).

export const TOOL_ORDER = ["Claude Code CLI", "Claude Code Desktop", "Codex CLI", "Codex Desktop"];
export const TOOL_NOTE: Record<string, string> = {
  "Claude Code CLI": "~/.claude/projects",
  "Codex CLI": "~/.codex/sessions",
};

export const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many || one + "s")}`;
