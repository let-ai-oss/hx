// Upload offsets are a claim about one gateway's store. These tests pin the
// reconcile rules that keep that claim honest across a gateway switch:
// adopt silently on first sight, treat cosmetic URL edits as no change, and
// on a REAL switch drop exactly the per-gateway knowledge — nothing local.
import { describe, expect, test } from "bun:test";
import { gatewayStampPending, reconcileGatewayInState, type HxState } from "./state.js";

const GW_A = "https://one.example/_api/hx-gateway";
const GW_B = "https://two.example/_api/hx-gateway";

function stateOnGateway(gateway?: string): HxState {
  return {
    ...(gateway === undefined ? {} : { gatewayBaseUrl: gateway }),
    files: {
      "/home/u/.claude/projects/p/s1.jsonl": {
        path: "/home/u/.claude/projects/p/s1.jsonl",
        family: "claude-cli",
        sessionId: "s1",
        offsets: { letai: 4096, "org-1": 512 },
        cwd: "~/work/repo",
        repoSlug: "acme/repo",
        attributionVersion: 3,
        lastKnownSize: 8192,
        lastMtimeMs: 111,
        lastUploadAtMs: 222,
        consecutiveFailures: 7,
        nextAttemptAtMs: 999,
        skipReason: "vault_offline",
        blocker: {
          reason: "vault_offline",
          destinations: [{ vaultOrgId: "org-1", reason: "vault_offline" }],
          firstSeenAtMs: 10,
          lastSeenAtMs: 20,
        },
        healCount: 2,
        healPausedUntilMs: 333,
      },
      "/home/u/.claude/projects/p/s2.jsonl": {
        // Never uploaded anywhere: nothing to drop, must not inflate the
        // "dropped offsets for N file(s)" count the log line quotes.
        path: "/home/u/.claude/projects/p/s2.jsonl",
        family: "claude-cli",
        sessionId: "s2",
        offsets: {},
        lastMtimeMs: 444,
        lastUploadAtMs: 0,
      },
    },
    destinations: {
      letai: { vaultOrgId: null, status: "ready", observedAtMs: 1 },
    },
    artifacts: { "claude-cli:s1:task": "hash" },
    deletedSessions: { "claude-cli:gone": 1 },
    childUploaders: { "s1:a1:r1": "/some/path" },
  };
}

describe("reconcileGatewayInState", () => {
  test("no stamp → adopts the gateway without touching anything", () => {
    const s = stateOnGateway(undefined);
    const r = reconcileGatewayInState(s, GW_A);
    expect(r.kind).toBe("adopted");
    expect(s.gatewayBaseUrl).toBe(GW_A);
    // The upgrade path must never trigger a fleet-wide re-upload.
    expect(s.files[Object.keys(s.files)[0]!]!.offsets).toEqual({ letai: 4096, "org-1": 512 });
    expect(s.deletedSessions).toEqual({ "claude-cli:gone": 1 });
  });

  test("same gateway → unchanged; trailing slash is cosmetic", () => {
    const s = stateOnGateway(GW_A);
    expect(reconcileGatewayInState(s, GW_A).kind).toBe("unchanged");
    expect(reconcileGatewayInState(s, `${GW_A}///`).kind).toBe("unchanged");
    expect(s.files[Object.keys(s.files)[0]!]!.offsets.letai).toBe(4096);
  });

  test("different gateway → resets per-gateway knowledge, keeps local facts", () => {
    const s = stateOnGateway(GW_A);
    const r = reconcileGatewayInState(s, GW_B);
    // Two files tracked, but only s1 had anything to drop — s2's empty
    // offsets must not inflate the count.
    expect(r).toEqual({ kind: "reset", filesReset: 1 });
    expect(s.files["/home/u/.claude/projects/p/s2.jsonl"]!.lastMtimeMs).toBe(0);
    expect(s.gatewayBaseUrl).toBe(GW_B);

    const f = s.files[Object.keys(s.files)[0]!]!;
    // Gone: everything that was only ever true of gateway A.
    expect(f.offsets).toEqual({});
    expect(f.consecutiveFailures).toBeUndefined();
    expect(f.nextAttemptAtMs).toBeUndefined();
    expect(f.skipReason).toBeUndefined();
    expect(f.blocker).toBeUndefined();
    expect(f.healCount).toBeUndefined();
    expect(f.healPausedUntilMs).toBeUndefined();
    expect(f.lastMtimeMs).toBe(0); // force re-examination on the next pass
    expect(f.lastUploadAtMs).toBe(0);
    expect(s.destinations).toBeUndefined();
    expect(s.artifacts).toBeUndefined();
    expect(s.childUploaders).toBeUndefined();
    // A tombstone from another environment must not withhold uploads here.
    expect(s.deletedSessions).toBeUndefined();

    // Kept: local truths the reset has no business erasing.
    expect(f.path).toBe("/home/u/.claude/projects/p/s1.jsonl");
    expect(f.sessionId).toBe("s1");
    expect(f.cwd).toBe("~/work/repo");
    expect(f.repoSlug).toBe("acme/repo");
    expect(f.attributionVersion).toBe(3);
    expect(f.lastKnownSize).toBe(8192);
  });

  test("switch back and forth resets both times — offsets never leak across", () => {
    const s = stateOnGateway(GW_A);
    reconcileGatewayInState(s, GW_B);
    s.files[Object.keys(s.files)[0]!]!.offsets = { letai: 100 };
    const r = reconcileGatewayInState(s, GW_A);
    expect(r.kind).toBe("reset");
    expect(s.files[Object.keys(s.files)[0]!]!.offsets).toEqual({});
  });
});

describe("gatewayStampPending", () => {
  test("absent stamp is never pending — the adopt path claims it silently", () => {
    expect(gatewayStampPending(stateOnGateway(undefined), GW_A)).toBe(false);
  });

  test("whitespace and trailing slashes are the SAME gateway on both sides", () => {
    // A stray space in config.json must not produce an eternal "pending"
    // row that reconcile (which trims) will never clear.
    expect(gatewayStampPending(stateOnGateway(GW_A), `  ${GW_A}/ `)).toBe(false);
    expect(gatewayStampPending(stateOnGateway(`${GW_A}//`), GW_A)).toBe(false);
  });

  test("a genuinely different gateway is pending until reconcile runs", () => {
    const s = stateOnGateway(GW_A);
    expect(gatewayStampPending(s, GW_B)).toBe(true);
    reconcileGatewayInState(s, GW_B);
    expect(gatewayStampPending(s, GW_B)).toBe(false);
  });
});
