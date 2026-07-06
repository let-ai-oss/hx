import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { destKey, offsetFor, migrateFileState, type FileState } from "./state.js";

describe("destKey", () => {
  it("maps null to letai and an org id to itself", () => {
    assert.equal(destKey(null), "letai");
    assert.equal(destKey("orgA"), "orgA");
  });
});

describe("offsetFor", () => {
  const fs = (offsets: Record<string, number>): FileState => ({
    path: "/p",
    family: "claude-cli",
    sessionId: "s",
    offsets,
    lastMtimeMs: 0,
    lastUploadAtMs: 0,
  });
  it("returns 0 for an unknown destination", () => {
    assert.equal(offsetFor(fs({}), null), 0);
  });
  it("returns the stored per-destination offset", () => {
    assert.equal(offsetFor(fs({ letai: 42, orgA: 7 }), null), 42);
    assert.equal(offsetFor(fs({ letai: 42, orgA: 7 }), "orgA"), 7);
  });
});

describe("migrateFileState", () => {
  it("moves a legacy single offset into offsets keyed by letai", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offset: 99,
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, { letai: 99 });
    assert.equal("offset" in out, false);
  });

  it("leaves an already-migrated state untouched", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      offsets: { orgA: 5 },
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, { orgA: 5 });
  });

  it("defaults to empty offsets when neither field is present", () => {
    const out = migrateFileState({
      path: "/p",
      family: "claude-cli",
      sessionId: "s",
      lastMtimeMs: 1,
      lastUploadAtMs: 2,
    });
    assert.deepEqual(out.offsets, {});
  });
});
