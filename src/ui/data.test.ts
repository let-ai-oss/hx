import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  classifyLogLine,
  destLabelFor,
  familyLabel,
  folderIdFor,
  groupDestinations,
  groupFolders,
  type FileFacts,
} from "./data.js";
import type { HeadMeta } from "../sources.js";
import type { FileState } from "../state.js";

const head = (over: Partial<HeadMeta>): HeadMeta => ({
  sessionId: "s",
  family: "claude-cli",
  cwd: "/work/app",
  gitBranch: null,
  repoSlug: null,
  entrypoint: null,
  originator: null,
  modelProvider: null,
  title: null,
  ...over,
});

const fstate = (over: Partial<FileState>): FileState => ({
  path: "/f.jsonl",
  family: "claude-cli",
  sessionId: "s",
  offsets: {},
  lastMtimeMs: 0,
  lastUploadAtMs: 0,
  ...over,
});

const fact = (p: string, h: Partial<HeadMeta>, s: Partial<FileState> | null): FileFacts => ({
  file: { path: p, size: 100, mtimeMs: 1, source: "claude" },
  head: head(h),
  state: s === null ? null : fstate(s),
});

describe("groupFolders", () => {
  it("groups by family+cwd, counts sessions, unions destinations", () => {
    const rows = groupFolders([
      fact("/a.jsonl", { cwd: "/w/app", repoSlug: "acme/app" }, { offsets: { letai: 10 }, lastUploadAtMs: 5 }),
      fact("/b.jsonl", { cwd: "/w/app" }, { offsets: { letai: 10, org1: 10 }, lastUploadAtMs: 9 }),
      fact("/c.jsonl", { cwd: "/w/other" }, null),
    ]);
    assert.equal(rows.length, 2);
    const app = rows.find((r) => r.path === "/w/app");
    assert.ok(app);
    assert.equal(app.sessions, 2);
    assert.equal(app.repo, "acme/app");
    assert.deepEqual(app.dests, ["letai", "org1"]);
    assert.equal(app.lastUploadAtMs, 9);
    assert.equal(app.unlinkedRepo, false); // reaches org1
    assert.equal(app.id, folderIdFor("claude-cli", "/w/app"));
  });

  it("flags a repo folder whose uploads only ever reached the personal store", () => {
    const rows = groupFolders([
      fact("/a.jsonl", { cwd: "/w/solo", repoSlug: "acme/solo" }, { offsets: { letai: 10 } }),
    ]);
    assert.equal(rows[0]?.unlinkedRepo, true);
  });

  it("ignores zero-byte destination offsets", () => {
    const rows = groupFolders([
      fact("/a.jsonl", { cwd: "/w/app" }, { offsets: { letai: 10, org9: 0 } }),
    ]);
    assert.deepEqual(rows[0]?.dests, ["letai"]);
  });
});

describe("groupDestinations", () => {
  it("aggregates bytes/sessions per store and sorts personal last", () => {
    const rows = groupDestinations([
      fact("/a.jsonl", { cwd: "/w/app" }, { offsets: { letai: 100, org1: 80 }, lastUploadAtMs: 3 }),
      fact("/b.jsonl", { cwd: "/w/two" }, { offsets: { org1: 20 }, lastUploadAtMs: 7 }),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.key, r.sessions, r.bytes, r.folders]),
      [
        ["org1", 2, 100, 2],
        ["letai", 1, 100, 1],
      ],
    );
    assert.equal(rows[0]?.lastUploadAtMs, 7);
    assert.equal(rows[1]?.personal, true);
  });

  it("carries blocker info onto the destination, preferring the org name", () => {
    const rows = groupDestinations([
      fact("/a.jsonl", { cwd: "/w" }, {
        offsets: { org1: 50 },
        blocker: {
          reason: "vault_offline",
          destinations: [{ vaultOrgId: "org1", reason: "vault_offline", orgName: "Acme" }],
          firstSeenAtMs: 1,
          lastSeenAtMs: 2,
        },
      }),
    ]);
    assert.equal(rows[0]?.blocked?.sessions, 1);
    assert.equal(rows[0]?.blocked?.orgName, "Acme");
    assert.equal(rows[0]?.label, "Acme");
  });
});

describe("classifyLogLine", () => {
  it("classifies upload, warning, and info lines", () => {
    assert.equal(classifyLogLine("  projects/x.jsonl (+184,201B → org, claude-cli, id…)"), "up");
    assert.equal(classifyLogLine("[hx] heartbeat error: connection closed"), "warn");
    assert.equal(classifyLogLine("[hx] uploads to nordbank not progressing; backing off 20s"), "warn");
    assert.equal(classifyLogLine("[hx] tick uploaded=3 failed=0"), "info");
    assert.equal(classifyLogLine("[groups] synced 2 CCD group(s)"), "info");
  });
});

describe("labels", () => {
  it("maps families and destination keys", () => {
    assert.equal(familyLabel("claude-cli"), "Claude Code CLI");
    assert.equal(familyLabel("codex-desktop"), "Codex Desktop");
    assert.equal(destLabelFor("letai"), "let.ai");
    assert.equal(destLabelFor("org-12345678901234567890"), "org-12345678…");
  });
});
