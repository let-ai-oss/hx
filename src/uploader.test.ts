import { describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { requestAppendUrl, putChunk } from "./uploader.js";
import type { HxConfig } from "./config.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// In fortress-direct mode the watcher builds an HxConfig pointed at the Fortress
// gateway with the capability token as the bearer (see watch.ts uploadConfigFor).
// requestAppendUrl must then hit the Fortress URL with that token.
describe("requestAppendUrl with a fortress-direct target", () => {
  it("posts append-url to the fortress gateway with the capability token", async () => {
    const calls: { url: string; auth?: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.authorization });
      return new Response(
        JSON.stringify({ chunkId: "c1", uploadUrl: "https://bucket/p", objectName: "o", expiresAt: "z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const fortressCfg: HxConfig = {
      gatewayBaseUrl: "https://f.example",
      accessToken: "captoken",
    };
    const res = await requestAppendUrl(fortressCfg, {
      family: "claude-cli",
      sessionId: "s1",
      byteCount: 10,
      repoSlug: "acme/app",
    });
    assert.equal(res.uploadUrl, "https://bucket/p");
    assert.equal(calls[0]?.url, "https://f.example/sessions/append-url");
    assert.equal(calls[0]?.auth, "Bearer captoken");
  });
});

describe("putChunk transport guard", () => {
  it("refuses to PUT session bytes to a plaintext-http upload URL", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      putChunk("http://bucket.example/p?sig=x", Buffer.from("secret")),
      /insecure transport/,
    );
    assert.equal(called, false); // guarded before any fetch — bytes never leave
  });

  it("allows an https upload URL", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await putChunk("https://bucket.example/p", Buffer.from("bytes"));
    assert.equal(seen, "https://bucket.example/p");
  });
});

describe("requestAppendUrl with a multi-destination response", () => {
  it("parses the destinations array when present", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          chunkId: "c1",
          uploadUrl: "https://b/p",
          objectName: "o",
          expiresAt: "z",
          vaultOrgId: null,
          destinations: [
            { vaultOrgId: null, chunkId: "c1", uploadUrl: "https://b/p", objectName: "o", expiresAt: "z", status: "ready" },
            { vaultOrgId: "orgA", status: "held", reason: "vault_offline", orgName: "Acme" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const res = await requestAppendUrl(
      { gatewayBaseUrl: "https://g", accessToken: "t" },
      { family: "claude-cli", sessionId: "s1", byteCount: 1, repoSlug: "acme/app" },
    );
    assert.equal(res.destinations?.length, 2);
    const first = res.destinations?.[0];
    assert.equal(first?.status, "ready");
    if (first?.status === "ready") assert.equal(first.chunkId, "c1");
  });

  it("leaves destinations undefined for an old gateway", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ chunkId: "c1", uploadUrl: "https://b/p", objectName: "o", expiresAt: "z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const res = await requestAppendUrl(
      { gatewayBaseUrl: "https://g", accessToken: "t" },
      { family: "claude-cli", sessionId: "s1", byteCount: 1 },
    );
    assert.equal(res.destinations, undefined);
  });
});
