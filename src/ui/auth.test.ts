import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  createUiAuth,
  isAllowedHost,
  isAllowedOrigin,
  mintToken,
  tokensMatch,
} from "./auth.js";

describe("mintToken", () => {
  it("produces distinct url-safe tokens with ≥256 bits", () => {
    const a = mintToken();
    const b = mintToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });
});

describe("tokensMatch", () => {
  it("accepts equal strings and rejects everything else", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abd", "abc"), false);
    assert.equal(tokensMatch("abcd", "abc"), false); // length differs — no throw
    assert.equal(tokensMatch("", "abc"), false);
    assert.equal(tokensMatch(null, "abc"), false);
    assert.equal(tokensMatch(undefined, "abc"), false);
  });
});

describe("createUiAuth", () => {
  it("exchanges the launch token for the session token, idempotently", () => {
    const auth = createUiAuth();
    assert.equal(auth.exchange("wrong"), null);
    assert.equal(auth.exchange(auth.launchToken), auth.sessionToken);
    assert.equal(auth.exchange(auth.launchToken), auth.sessionToken);
  });

  it("validates only the session token", () => {
    const auth = createUiAuth();
    assert.equal(auth.isValidSession(auth.sessionToken), true);
    assert.equal(auth.isValidSession(auth.launchToken), false);
    assert.equal(auth.isValidSession(null), false);
  });
});

describe("isAllowedHost", () => {
  it("accepts loopback spellings of our port only", () => {
    assert.equal(isAllowedHost("localhost:8000", 8000), true);
    assert.equal(isAllowedHost("127.0.0.1:8000", 8000), true);
    assert.equal(isAllowedHost("[::1]:8000", 8000), true);
    assert.equal(isAllowedHost("LOCALHOST:8000", 8000), true);
    assert.equal(isAllowedHost("localhost:8001", 8000), false);
    assert.equal(isAllowedHost("evil.example:8000", 8000), false);
    assert.equal(isAllowedHost("localhost", 8000), false);
    assert.equal(isAllowedHost(null, 8000), false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts absent or loopback origins of our port only", () => {
    assert.equal(isAllowedOrigin(null, 8000), true);
    assert.equal(isAllowedOrigin("http://localhost:8000", 8000), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:8000", 8000), true);
    assert.equal(isAllowedOrigin("http://localhost:5199", 8000), false);
    assert.equal(isAllowedOrigin("https://evil.example", 8000), false);
    assert.equal(isAllowedOrigin("null", 8000), false);
  });
});
