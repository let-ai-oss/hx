import { test, expect } from "bun:test";
import { isRemoteNewer } from "./update.js";

test("newer remote semver triggers update", () => {
  expect(isRemoteNewer("76.0.0", "76.0.1")).toBe(true);
  expect(isRemoteNewer("76.0.0", "77.0.0")).toBe(true);
});

test("same-or-older remote does not update", () => {
  expect(isRemoteNewer("76.0.1", "76.0.1")).toBe(false);
  expect(isRemoteNewer("76.1.0", "76.0.9")).toBe(false);
});

test("unparseable remote version means 'unknown' -> false (fall through to sha guard)", () => {
  expect(isRemoteNewer("76.0.0", "garbage")).toBe(false);
  expect(isRemoteNewer("76.0.0", null)).toBe(false);
});
