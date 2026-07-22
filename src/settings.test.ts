import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  isPaused,
  readSettings,
  shouldSkipFile,
  writeSettings,
  type HxSettings,
} from "./settings.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "hx-settings-")), "settings.json");

describe("settings file", () => {
  it("defaults when absent or corrupt, round-trips patches", async () => {
    const p = tmpPath();
    assert.deepEqual(await readSettings(p), DEFAULT_SETTINGS);
    await writeSettings({ personalSync: false }, p);
    await writeSettings({ pause: { untilMs: 123 } }, p);
    const s = await readSettings(p);
    assert.equal(s.personalSync, false); // earlier patch survives later ones
    assert.deepEqual(s.pause, { untilMs: 123 });
  });

  it("sanitizes malformed fields instead of trusting them", async () => {
    const p = tmpPath();
    await writeSettings(
      {
        excludedFolders: [{ family: "claude-cli", cwd: "~/x" }, { nope: 1 } as never],
        excludeRules: ["~/ok", 42 as never],
      },
      p,
    );
    const s = await readSettings(p);
    assert.deepEqual(s.excludedFolders, [{ family: "claude-cli", cwd: "~/x" }]);
    assert.deepEqual(s.excludeRules, ["~/ok"]);
  });
});

describe("isPaused", () => {
  it("handles unpaused, timed, expired, and forever", () => {
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: null }, 100), false);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: 200 } }, 100), true);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: 200 } }, 300), false);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: null } }, 1e15), true);
  });
});

describe("shouldSkipFile", () => {
  const base: HxSettings = { ...DEFAULT_SETTINGS };

  it("matches excluded folders by family + cwd exactly", () => {
    const s: HxSettings = { ...base, excludedFolders: [{ family: "claude-cli", cwd: "~/w/app" }] };
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/w/app" }), true);
    assert.equal(shouldSkipFile(s, { family: "codex-cli", cwd: "~/w/app" }), false);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/w/app2" }), false);
  });

  it("matches path rules as boundary-aware prefixes, future folders included", () => {
    const s: HxSettings = { ...base, excludeRules: ["~/personal-finance"] };
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finance" }), true);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finance/q3" }), true);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finances" }), false);
  });

  it("gates personal (repo-less) sessions only when personalSync is off", () => {
    const off: HxSettings = { ...base, personalSync: false };
    assert.equal(shouldSkipFile(off, { family: "claude-cli", cwd: "~/notes", repoSlug: null }), true);
    assert.equal(shouldSkipFile(off, { family: "claude-cli", cwd: "~/w", repoSlug: "acme/app" }), false);
    assert.equal(shouldSkipFile(base, { family: "claude-cli", cwd: "~/notes", repoSlug: null }), false);
  });

  it("treats unknown identity as work — never skips legacy entries blindly", () => {
    const strict: HxSettings = {
      ...base,
      personalSync: false,
      excludeRules: ["~/w"],
    };
    // No cwd, no repoSlug (legacy entry): neither rule nor personal gate fires.
    assert.equal(shouldSkipFile(strict, { family: "claude-cli" }), false);
    // repoSlug undefined (unknown) is NOT the same as null (known repo-less).
    assert.equal(shouldSkipFile({ ...base, personalSync: false }, { family: "claude-cli", cwd: "~/x" }), false);
  });
});
