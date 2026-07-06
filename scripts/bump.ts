#!/usr/bin/env bun
// Bump the hx package semver. `bun run bump [patch|minor|major]` (default patch).
// Enforces the update-bridge floor: major must stay >= 76 (see src/version.ts).
import pkg from "../package.json";

type Level = "patch" | "minor" | "major";
const level = (process.argv[2] ?? "patch") as Level;
if (!["patch", "minor", "major"].includes(level)) {
  console.error(`hx bump: unknown level "${level}" (use patch|minor|major)`);
  process.exit(1);
}

const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) {
  console.error(`hx bump: package.json version is not semver: ${pkg.version}`);
  process.exit(1);
}
let major = Number(m[1]);
let minor = Number(m[2]);
let patch = Number(m[3]);
if (level === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (level === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
if (major < 76) {
  console.error(`hx bump: refusing major ${major} < 76 (breaks the update bridge)`);
  process.exit(1);
}

const next = `${major}.${minor}.${patch}`;
const path = new URL("../package.json", import.meta.url);
const raw = await Bun.file(path).text();
await Bun.write(path, raw.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`));
console.log(`hx version: ${pkg.version} → ${next}`);
