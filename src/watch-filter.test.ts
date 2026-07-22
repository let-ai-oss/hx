import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { filterWatched } from "./watch.js";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import type { DiscoveredFile } from "./sources.js";
import type { FileState, HxState } from "./state.js";

const file = (p: string): DiscoveredFile => ({ path: p, size: 10, mtimeMs: 1, source: "claude" });

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
});
