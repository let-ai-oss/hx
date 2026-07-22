import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeExistingInstance,
  readServerInfo,
  removeServerInfo,
  writeServerInfo,
  type ServerInfo,
} from "./instance.js";

const tmp = () => mkdtempSync(join(tmpdir(), "hx-ui-instance-"));

const INFO: ServerInfo = { port: 8123, pid: 4242, launchToken: "tok_launch" };

describe("server-info file", () => {
  it("round-trips and removes", async () => {
    const dir = tmp();
    assert.equal(await readServerInfo(dir), null);
    await writeServerInfo(INFO, dir);
    assert.deepEqual(await readServerInfo(dir), INFO);
    await removeServerInfo(dir);
    assert.equal(await readServerInfo(dir), null);
    await removeServerInfo(dir); // second removal is a no-op, not an error
  });

  it("treats malformed content as absent", async () => {
    const dir = tmp();
    await writeServerInfo({ ...INFO, port: "nope" as unknown as number }, dir);
    assert.equal(await readServerInfo(dir), null);
  });
});

type FetchStub = (url: string, init?: { method?: string }) => Response;

const fetcher = (fn: FetchStub): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(fn(String(input), init as { method?: string }))) as typeof fetch;

describe("probeExistingInstance", () => {
  it("returns the launch url when identity and ownership both verify", async () => {
    const seen: string[] = [];
    const result = await probeExistingInstance(
      INFO,
      fetcher((url, init) => {
        seen.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/api/instance")) {
          return Response.json({ app: "hx-ui", version: "0.0.0" });
        }
        return Response.json({ sessionToken: "s" });
      }),
    );
    assert.deepEqual(result, { url: "http://localhost:8123/#k=tok_launch" });
    assert.deepEqual(seen, [
      "GET http://127.0.0.1:8123/api/instance",
      "POST http://127.0.0.1:8123/api/auth",
    ]);
  });

  it("rejects a foreign app on the port", async () => {
    const result = await probeExistingInstance(
      INFO,
      fetcher(() => Response.json({ app: "something-else" })),
    );
    assert.equal(result, null);
  });

  it("rejects an instance that refuses our launch token", async () => {
    const result = await probeExistingInstance(
      INFO,
      fetcher((url) =>
        url.endsWith("/api/instance")
          ? Response.json({ app: "hx-ui", version: "0.0.0" })
          : new Response(null, { status: 401 }),
      ),
    );
    assert.equal(result, null);
  });

  it("treats a dead port as stale", async () => {
    const result = await probeExistingInstance(INFO, (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    assert.equal(result, null);
  });
});
