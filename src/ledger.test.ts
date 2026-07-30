import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildLedger, classifyFile, isDestinationOffline, LIVE_WINDOW_MS, needsAttention } from "./ledger.js";
import { applyDestinationReports, type FileState, type HxState } from "./state.js";

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const DAY = 86_400_000;

const file = (path: string, size: number, ageMs = LIVE_WINDOW_MS * 2) => ({
  path,
  size,
  mtimeMs: NOW - ageMs,
});

const entry = (path: string, offsets: Record<string, number>, extra: Partial<FileState> = {}): FileState => ({
  path,
  family: "claude-cli",
  sessionId: path,
  offsets,
  lastMtimeMs: NOW,
  lastUploadAtMs: NOW,
  ...extra,
});

/** A state with one offline Fortress ("orgA") and the primary bucket ready. */
function stateWithOfflineFortress(files: Record<string, FileState>, heldDays = 13): HxState {
  const state: HxState = { files };
  applyDestinationReports(
    state,
    [
      { vaultOrgId: null, status: "ready" },
      { vaultOrgId: "orgA", status: "held", orgName: "Den Co", lastSeenAt: null },
    ],
    NOW - heldDays * DAY,
  );
  return state;
}

describe("ledger classification", () => {
  it("counts a session delivered to every reachable store as delivered", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 100, orgA: 100 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "delivered");
  });

  it("is WAITING, not uploading, when only an offline store is owed bytes", () => {
    // The regression the whole redesign exists for: fully on the primary,
    // nothing on an offline Fortress. minOffset() scored this 0 and dragged
    // the device below 100% forever.
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 100, orgA: 0 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "waiting");
    assert.equal(c.offline.get("orgA"), 100);
    assert.equal(c.reachableBytes, 0);
  });

  it("is UPLOADING when a reachable store is behind", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 40, orgA: 0 }) });
    const c = classifyFile(file("a", 100), state, NOW);
    assert.equal(c.state, "uploading");
    assert.equal(c.reachableBytes, 60);
  });

  it("treats a live session as in progress even with an unsent tail", () => {
    // A live jsonl always has a few bytes in flight between the write and the
    // next tick; counting that as backlog is what kept the number off 100%.
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 90 }) });
    const c = classifyFile(file("a", 100, 60_000), state, NOW);
    assert.equal(c.state, "in_progress");
  });

  it("reclassifies once the live window lapses", () => {
    const state = stateWithOfflineFortress({ a: entry("a", { letai: 90 }) });
    const c = classifyFile(file("a", 100, LIVE_WINDOW_MS + 1_000), state, NOW);
    assert.equal(c.state, "uploading");
  });

  it("never excuses the primary bucket, even if reported held", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: null, status: "held" }], NOW);
    assert.equal(isDestinationOffline(state, "letai"), false);
  });

  it("bills a never-seeded file to the primary as real backlog", () => {
    const state: HxState = { files: {} };
    const c = classifyFile(file("new", 500), state, NOW);
    assert.equal(c.state, "uploading");
    assert.equal(c.reachableBytes, 500);
  });
});

describe("ledger percentage", () => {
  it("reads 100% when the only stragglers are live tails and offline stores", () => {
    const files = {
      done: entry("done", { letai: 10, orgA: 10 }),
      held: entry("held", { letai: 10, orgA: 0 }),
      live: entry("live", { letai: 5 }),
    };
    const ledger = buildLedger({
      files: [file("done", 10), file("held", 10), file("live", 10, 1_000)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.percent, 100);
    assert.equal(ledger.delivered, 1);
    assert.equal(ledger.waiting, 1);
    assert.equal(ledger.inProgress, 1);
    // The parts must account for every session — the number is auditable.
    assert.equal(
      ledger.delivered + ledger.inProgress + ledger.uploading + ledger.waiting + ledger.incomplete,
      ledger.total,
    );
  });

  it("drops below 100% for a real backlog", () => {
    const files = { a: entry("a", { letai: 0 }), b: entry("b", { letai: 10 }) };
    const ledger = buildLedger({
      files: [file("a", 10), file("b", 10)],
      state: stateWithOfflineFortress(files),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(ledger.uploading, 1);
    assert.equal(ledger.percent, 50);
  });

  it("drops below 100% for real loss", () => {
    const paths = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const files = Object.fromEntries(paths.map((p) => [p, entry(p, { letai: 10 })]));
    const ledger = buildLedger({
      files: paths.map((p) => file(p, 10)),
      state: stateWithOfflineFortress(files),
      // Sessions whose source vanished mid-upload are not on disk any more, so
      // they add to the total rather than being found among `files`.
      incompleteSessions: 1,
      nowMs: NOW,
    });
    assert.equal(ledger.delivered, 9);
    assert.equal(ledger.incomplete, 1);
    assert.equal(ledger.percent, 90);
    assert.equal(ledger.total, 10);
  });

  it("is 100% on an empty device rather than NaN", () => {
    const ledger = buildLedger({ files: [], state: { files: {} }, incompleteSessions: 0, nowMs: NOW });
    assert.equal(ledger.percent, 100);
    assert.equal(ledger.total, 0);
  });
});

describe("lagging destinations", () => {
  it("names the offline Fortress and ages the outage", () => {
    const files = { a: entry("a", { letai: 10, orgA: 0 }) };
    const ledger = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 13),
      incompleteSessions: 0,
      nowMs: NOW,
      orgNames: { orgA: "Den Co" },
    });
    assert.equal(ledger.lagging.length, 1);
    assert.equal(ledger.lagging[0]?.label, "Den Co");
    assert.equal(ledger.lagging[0]?.sessions, 1);
    assert.equal(ledger.lagging[0]?.offlineDays, 13);
    assert.equal(ledger.waitingBytes, 10);
  });

  it("flags only outages old enough to need a decision", () => {
    const files = { a: entry("a", { letai: 10, orgA: 0 }) };
    const young = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 2),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(needsAttention(young).length, 0);
    const old = buildLedger({
      files: [file("a", 10)],
      state: stateWithOfflineFortress(files, 22),
      incompleteSessions: 0,
      nowMs: NOW,
    });
    assert.equal(needsAttention(old).length, 1);
  });
});

describe("destination registry", () => {
  it("survives a cleared skipReason latch", () => {
    // The reporting bug in one assertion: the file's transient hold fields are
    // gone (a clean pass wiped them) but the destination is still known to be
    // held, so the session is still correctly reported as waiting.
    const files = { a: entry("a", { letai: 10, orgA: 0 }, { skipReason: undefined, blocker: undefined }) };
    const state = stateWithOfflineFortress(files);
    assert.equal(state.files.a?.skipReason, undefined);
    assert.equal(classifyFile(file("a", 10), state, NOW).state, "waiting");
  });

  it("keeps the original outage start across repeated held reports", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW - 5 * DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW);
    assert.equal(state.destinations?.orgA?.heldSinceMs, NOW - 5 * DAY);
  });

  it("clears the outage when the destination comes back", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held" }], NOW - 5 * DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "ready" }], NOW);
    assert.equal(state.destinations?.orgA?.status, "ready");
    assert.equal(state.destinations?.orgA?.heldSinceMs, undefined);
    assert.equal(isDestinationOffline(state, "orgA"), false);
  });

  it("remembers a name learned while held after the store recovers", () => {
    const state: HxState = { files: {} };
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "held", orgName: "Den Co" }], NOW - DAY);
    applyDestinationReports(state, [{ vaultOrgId: "orgA", status: "ready" }], NOW);
    assert.equal(state.destinations?.orgA?.orgName, "Den Co");
  });
});
