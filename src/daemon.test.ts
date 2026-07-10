import { test, expect } from "bun:test";
import { shquote, renderBootstrap, insertHookBlock, stripHookBlock } from "./daemon.js";

test("shquote wraps in single quotes", () => {
  expect(shquote("/home/user/.let/bin/hx")).toBe("'/home/user/.let/bin/hx'");
});

test("shquote escapes embedded single quotes so it can't break out", () => {
  // A path with a quote must not terminate the quoting early.
  expect(shquote("/tmp/a'b")).toBe(`'/tmp/a'\\''b'`);
});

test("renderBootstrap emits the guarded, self-healing launcher", () => {
  const out = renderBootstrap("/home/user/.let/bin/hx");
  // Guards: only run when connected and not disabled.
  expect(out).toContain("config.json");
  expect(out).toContain("disabled");
  // Detach + respawn, mirroring systemd Restart=always / RestartSec=5.
  expect(out).toContain("setsid sh -c");
  expect(out).toContain("while true; do");
  expect(out).toContain("watch >>");
  expect(out).toContain("sleep 5");
  // Already-running guard via a zombie-aware liveness check (not bare kill -0).
  expect(out).toContain("__hx_alive");
  expect(out).toContain("/proc/");
});

test("renderBootstrap guards the supervisor with a lifetime-held flock singleton", () => {
  const out = renderBootstrap("/home/user/.let/bin/hx");
  // Atomic "at most one supervisor": take an flock before writing the pidfile;
  // bow out if another holds it. Kernel releases on death, so no stale leak.
  expect(out).toContain("flock -n 9");
  // Guarded so an image without flock still starts (fast-path-only fallback).
  expect(out).toContain("if command -v flock");
});

test("renderBootstrap shell-escapes the binary path", () => {
  const evil = "/tmp/weird '; rm -rf ~; '/hx";
  const out = renderBootstrap(evil);
  // The whole path — metacharacters and all — sits inside a single-quoted token,
  // so it's an inert literal, never executed. Its embedded quotes are neutralized
  // as '\'' (close, escaped-quote, reopen).
  expect(out).toContain(shquote(evil));
  expect(out).toContain(`'\\''`);
});

test("insertHookBlock adds the marker block once (idempotent)", () => {
  const once = insertHookBlock("# my bashrc\nexport FOO=1\n");
  expect(once).toContain("# >>> hx >>>");
  expect(once).toContain("# <<< hx <<<");
  expect(once).toContain("bootstrap.sh");
  // Second application is a no-op — no duplicate block.
  const twice = insertHookBlock(once);
  expect(twice).toBe(once);
  expect(twice.match(/# >>> hx >>>/g)).toHaveLength(1);
});

test("stripHookBlock removes exactly what insertHookBlock added", () => {
  const original = "# my bashrc\nexport FOO=1\n";
  const wired = insertHookBlock(original);
  const unwired = stripHookBlock(wired);
  expect(unwired).not.toContain("# >>> hx >>>");
  expect(unwired).toContain("export FOO=1");
});

test("stripHookBlock leaves an unrelated file untouched", () => {
  const content = "# my bashrc\nexport FOO=1\n";
  expect(stripHookBlock(content)).toBe(content);
});
