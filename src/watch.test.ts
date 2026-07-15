import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  SessionUpstreamUnavailable,
  classifyUpstreamError,
  collectSkipped,
} from "./watch.js";
import { HxHttpError } from "./uploader.js";
import type { FileState, HxState } from "./state.js";
import type { DiscoveredFile } from "./sources.js";

const vaultOffline = () =>
  new HxHttpError(503, 'append-url failed: 503 {"error":"vault_offline"}');
const genericUnavailable = (status: number) =>
  new HxHttpError(status, `commit failed: ${status} Service Unavailable`);

describe("classifyUpstreamError", () => {
  it("treats vault_offline as per-session on either route", () => {
    for (const fortress of [false, true]) {
      const out = classifyUpstreamError(vaultOffline(), fortress);
      assert.ok(out instanceof SessionUpstreamUnavailable);
      assert.equal(out.reason, "vault_offline");
      assert.equal(out.status, 503);
    }
  });

  it("treats a direct-store 5xx/429 as store_unreachable", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      const out = classifyUpstreamError(genericUnavailable(status), true);
      assert.ok(out instanceof SessionUpstreamUnavailable);
      assert.equal(out.reason, "store_unreachable");
      assert.equal(out.status, status);
    }
  });

  it("lets a cloud-gateway 5xx/429 fall through (possible wholesale outage)", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      assert.equal(classifyUpstreamError(genericUnavailable(status), false), null);
    }
  });

  it("never treats a 4xx as unavailable, even on a direct route", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      const err = new HxHttpError(status, `commit failed: ${status} nope`);
      assert.equal(classifyUpstreamError(err, true), null);
      assert.equal(classifyUpstreamError(err, false), null);
    }
  });

  it("treats a direct-route network failure as store_unreachable (no status)", () => {
    const out = classifyUpstreamError(new Error("ECONNREFUSED"), true);
    assert.ok(out instanceof SessionUpstreamUnavailable);
    assert.equal(out.reason, "store_unreachable");
    assert.equal(out.status, null);
  });

  it("lets a cloud-route network failure fall through", () => {
    assert.equal(classifyUpstreamError(new Error("ECONNREFUSED"), false), null);
  });

  it("preserves the original error as the cause", () => {
    const original = vaultOffline();
    const out = classifyUpstreamError(original, false);
    assert.equal(out?.cause, original);
  });
});

describe("collectSkipped", () => {
  const file = (path: string): DiscoveredFile => ({
    path,
    size: 10,
    mtimeMs: 1,
    source: "claude",
  });
  const fileState = (path: string, over: Partial<FileState>): FileState => ({
    path,
    family: "claude-cli",
    sessionId: `sess-${path}`,
    offsets: {},
    lastMtimeMs: 1,
    lastUploadAtMs: 0,
    ...over,
  });
  const state = (entries: FileState[]): HxState => ({
    files: Object.fromEntries(entries.map((e) => [e.path, e])),
  });

  it("includes a discovered file that is skipped, with its reason and retry time", () => {
    const files = [file("/a"), file("/b")];
    const st = state([
      fileState("/a", { skipReason: "vault_offline", nextAttemptAtMs: 123 }),
      fileState("/b", {}),
    ]);
    const out = collectSkipped(files, st);
    assert.deepEqual(out, [
      { path: "/a", sessionId: "sess-/a", reason: "vault_offline", nextAttemptAtMs: 123 },
    ]);
  });

  it("excludes a skipped entry whose file is no longer discovered", () => {
    const st = state([fileState("/gone", { skipReason: "store_unreachable" })]);
    assert.deepEqual(collectSkipped([], st), []);
  });

  it("excludes files with no skipReason", () => {
    assert.deepEqual(collectSkipped([file("/a")], state([fileState("/a", {})])), []);
  });
});
