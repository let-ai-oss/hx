// The gateway-switch adoption decision: what a verify answer means for the
// local offset when the device has just been pointed at a different gateway.
import { describe, expect, it } from "bun:test";
import { adoptionDecision } from "./watch.js";

describe("adoptionDecision", () => {
  it("adopts the local size when the new gateway already holds the session", () => {
    // The common migration case: the environment was seeded from the old one,
    // so the session is already there byte-for-byte. Nothing to upload.
    expect(adoptionDecision("ok", 4_096, 4_096)).toEqual({ action: "adopt", offset: 4_096 });
  });

  it("resumes mid-file when the gateway holds a prefix", () => {
    // Session files are append-only, so a shorter canonical is a prefix: send
    // the tail instead of the whole file.
    expect(adoptionDecision("divergent", 3_000, 10_000)).toEqual({
      action: "resume",
      offset: 3_000,
    });
  });

  it("re-uploads in full when the gateway holds nothing", () => {
    expect(adoptionDecision("divergent", 0, 10_000)).toEqual({ action: "replace", offset: 0 });
    expect(adoptionDecision("divergent", null, 10_000)).toEqual({ action: "replace", offset: 0 });
  });

  it("re-uploads in full when the canonical is LONGER than ours", () => {
    // Appends cannot explain that, so the canonical is not our file's prefix —
    // adopting it would strand a foreign tail. Fall back to replace.
    expect(adoptionDecision("divergent", 20_000, 10_000)).toEqual({ action: "replace", offset: 0 });
  });

  it("tombstones a session the server deleted", () => {
    expect(adoptionDecision("deleted", null, 10_000)).toEqual({ action: "tombstone", offset: 0 });
  });

  it("leaves a skipped session alone (vault-routed: not this pass's business)", () => {
    expect(adoptionDecision("skipped", null, 10_000)).toEqual({ action: "replace", offset: 0 });
  });
});
