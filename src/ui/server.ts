// The HX Client UI server: a pure request handler plus a thin Bun.serve
// shell. Everything stateful (auth tokens, asset map, bound port) rides in a
// context object so the handler is unit-testable with plain Request values.
//
// Surface (Phase relevant to serving the static app; data endpoints arrive
// with the view wiring):
//   GET  /            → index.html            (no auth — app shell only)
//   GET  /assets/*    → embedded static files (no auth)
//   GET  /api/instance → { app, version }     (no auth — instance discovery)
//   POST /api/auth     → { sessionToken }     (launch-token gated)
//   GET  /api/ping     → 204                  (session-token gated)
//
// Static serving is unauthenticated by design: the browser must be able to
// load the shell before the SPA has exchanged the fragment token, and the
// shell contains no data — every read lives behind /api with the session
// header. Host/Origin checks apply to every request, static included.

import type { Server } from "bun";
import { isAllowedHost, isAllowedOrigin, type UiAuth } from "./auth.js";
import { contentTypeFor, type UiAssets } from "./assets.js";
import { instanceIdentity } from "./instance.js";
import type { SessionVM, UiSnapshot, LogLevel } from "./data.js";
import type { PreviewLine } from "./preview.js";

/** Read-only data the API serves; injected so the handler tests with fakes. */
export interface UiProviders {
  snapshot(): Promise<UiSnapshot>;
  sessions(folderId: string): Promise<SessionVM[]>;
  preview(filePath: string): Promise<PreviewLine[] | null>;
  logs(maxLines: number): Promise<{ body: string; level: LogLevel }[]>;
  probe(): Promise<unknown>;
  whoami(): Promise<{ email: string | null }>;
}

export interface UiServerCtx {
  auth: UiAuth;
  assets: UiAssets;
  providers: UiProviders;
  /** The bound port — Host/Origin checks compare against it. */
  port: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function finish(res: Response, cache: string): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  res.headers.set("cache-control", cache);
  return res;
}

function json(body: unknown, status = 200, cache = "no-store"): Response {
  return finish(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
    cache,
  );
}

function apiError(status: number, error: string): Response {
  return json({ error }, status);
}

export async function handleUiRequest(req: Request, ctx: UiServerCtx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!isAllowedHost(req.headers.get("host"), ctx.port)) {
    return apiError(403, "forbidden host");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (!isAllowedOrigin(req.headers.get("origin"), ctx.port)) {
      return apiError(403, "forbidden origin");
    }
  }

  if (path.startsWith("/api/")) return handleApi(req, path, ctx);

  // Static shell. GET/HEAD only; everything resolves through the asset map.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return apiError(405, "method not allowed");
  }
  const assetPath = path === "/" ? "/index.html" : path;
  const filePath = ctx.assets.files[assetPath];
  if (!filePath) {
    return finish(new Response("Not found", { status: 404 }), "no-store");
  }
  const cache =
    assetPath === "/index.html"
      ? "no-cache"
      : assetPath.startsWith("/assets/")
        ? "public, max-age=31536000, immutable" // Vite content-hashed names
        : "public, max-age=3600";
  return finish(
    new Response(Bun.file(filePath), {
      headers: { "content-type": contentTypeFor(assetPath) },
    }),
    cache,
  );
}

async function handleApi(req: Request, path: string, ctx: UiServerCtx): Promise<Response> {
  if (path === "/api/instance") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return apiError(405, "method not allowed");
    }
    return json(instanceIdentity());
  }

  if (path === "/api/auth") {
    if (req.method !== "POST") return apiError(405, "method not allowed");
    let token: unknown;
    try {
      const body = (await req.json()) as { token?: unknown };
      token = body.token;
    } catch {
      return apiError(400, "invalid body");
    }
    if (typeof token !== "string") return apiError(400, "invalid body");
    const sessionToken = ctx.auth.exchange(token);
    if (!sessionToken) return apiError(401, "invalid token");
    return json({ sessionToken });
  }

  if (!ctx.auth.isValidSession(req.headers.get("x-hx-ui-token"))) {
    return apiError(401, "unauthorized");
  }

  if (path === "/api/ping") {
    return finish(new Response(null, { status: 204 }), "no-store");
  }

  if (req.method !== "GET") return apiError(405, "method not allowed");
  const query = new URL(req.url).searchParams;

  switch (path) {
    case "/api/snapshot":
      return json(await ctx.providers.snapshot());
    case "/api/sessions": {
      const folder = query.get("folder");
      if (!folder) return apiError(400, "missing folder");
      return json(await ctx.providers.sessions(folder));
    }
    case "/api/session-preview": {
      const file = query.get("path");
      if (!file) return apiError(400, "missing path");
      const lines = await ctx.providers.preview(file);
      if (lines === null) return apiError(404, "not found");
      return json({ lines });
    }
    case "/api/logs": {
      const n = Math.min(2_000, Math.max(50, Number(query.get("lines")) || 500));
      return json({ lines: await ctx.providers.logs(n) });
    }
    case "/api/probe":
      return json(await ctx.providers.probe());
    case "/api/whoami":
      return json(await ctx.providers.whoami());
    default:
      return apiError(404, "not found");
  }
}

/**
 * Bind 127.0.0.1:<port>. Returns null when the port is taken (the caller
 * decides between instance-reuse and scanning); rethrows anything else
 * (EACCES and friends are real errors, not "try the next port").
 */
export function tryServeUi(
  port: number,
  auth: UiAuth,
  assets: UiAssets,
  providers: UiProviders,
): Server<undefined> | null {
  const ctx: UiServerCtx = { auth, assets, providers, port };
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      // SSE streams ride this connection later; pings stay well under it.
      idleTimeout: 120,
      fetch: (req) => handleUiRequest(req, ctx),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") return null;
    throw err;
  }
}
