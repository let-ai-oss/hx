import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { filterWatched, snapshotFrom } from "./watch.js";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import type { DiscoveredFile } from "./sources.js";
import type { FileState, HxState } from "./state.js";

const file = (p: string): DiscoveredFile => ({ path: p, size: 10, mtimeMs: 1, source: "claude", rootDir: "/home/u/.claude" });

const entry = (p: string, over: Partial<FileState>): FileState => ({
  path: p,
  family: "claude-cli",
  sessionId: p,
  offsets: {},
  lastMtimeMs: 1,
  lastUploadAtMs: 0,
  ...over,
});

describe("filterWatched", () => {
  const files = [file("/a"), file("/b"), file("/c")];
  const state: HxState = {
    files: {
      "/a": entry("/a", { cwd: "~/keep", repoSlug: "acme/app" }),
      "/b": entry("/b", { cwd: "~/private", repoSlug: null }),
      // "/c" has no entry yet — must pass (the tick's pre-upload check covers it)
    },
  };

  it("passes everything under default settings", () => {
    assert.deepEqual(filterWatched(files, state, DEFAULT_SETTINGS).map((f) => f.path), ["/a", "/b", "/c"]);
  });

  it("drops excluded folders but keeps unknown files", () => {
    const s: HxSettings = { ...DEFAULT_SETTINGS, excludeRules: ["~/private"] };
    assert.deepEqual(filterWatched(files, state, s).map((f) => f.path), ["/a", "/c"]);
  });

  it("drops repo-less sessions when personal sync is off", () => {
    const s: HxSettings = { ...DEFAULT_SETTINGS, personalSync: false };
    assert.deepEqual(filterWatched(files, state, s).map((f) => f.path), ["/a", "/c"]);
  });

  it("drops sessions the server permanently deleted (tombstoned)", () => {
    const s: HxState = { ...state, deletedSessions: { "claude-cli:/b": 1 } };
    assert.deepEqual(filterWatched(files, s, DEFAULT_SETTINGS).map((f) => f.path), ["/a", "/c"]);
  });

  it("still passes an untracked file even when its session is tombstoned", () => {
    // No state entry means no identity to match here — the first attempt 410s,
    // records the tombstone, and the NEXT pass drops the file above.
    const s: HxState = { files: {}, deletedSessions: { "claude-cli:/c": 1 } };
    assert.deepEqual(filterWatched([file("/c")], s, DEFAULT_SETTINGS).map((f) => f.path), ["/c"]);
  });

  it("keeps a tombstoned session out of the sync snapshot entirely", () => {
    // The incident shape: a fully-present local file whose session was hard-
    // deleted server-side read as "1 session pending" in hx status forever.
    const s: HxState = { ...state, deletedSessions: { "claude-cli:/b": 1 } };
    const snap = snapshotFrom(filterWatched(files, s, DEFAULT_SETTINGS), s);
    assert.equal(snap.total, 2);
    assert.equal(snap.totalBytes, 20);
  });
});
