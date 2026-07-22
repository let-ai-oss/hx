// Auth for the local HX Client UI server.
//
// Model: `hx ui` mints a per-run LAUNCH token and opens the browser at
// http://localhost:<port>/#k=<launch-token>. The SPA exchanges the fragment
// (which never travels on the wire) via POST /api/auth for a SESSION token it
// keeps in sessionStorage and sends on every /api call in the
// `x-hx-ui-token` header. A custom header is deliberately used instead of a
// cookie: cookies on localhost are shared across every port (any other local
// dev server would receive them), while a header bound to the page's origin
// is port-scoped and CSRF-proof by construction.
//
// Both tokens live only in this process (and the launch token in the 0600
// server-info file so a second `hx ui` can reopen the running instance).
// The exchange is idempotent — every holder of the launch token gets the same
// session token, so re-opening the launch URL in a second tab just works.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time string comparison. Hashing both sides first makes the
 * comparison length-independent, so nothing about the expected token (not
 * even its length) leaks through timing.
 */
export function tokensMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface UiAuth {
  readonly launchToken: string;
  readonly sessionToken: string;
  /** POST /api/auth: launch token in, session token out. */
  exchange(launchToken: string): string | null;
  /** Gate for /api/* requests: the x-hx-ui-token header value. */
  isValidSession(headerToken: string | null): boolean;
}

export function createUiAuth(): UiAuth {
  const launchToken = mintToken();
  const sessionToken = mintToken();
  return {
    launchToken,
    sessionToken,
    exchange(candidate) {
      return tokensMatch(candidate, launchToken) ? sessionToken : null;
    },
    isValidSession(headerToken) {
      return tokensMatch(headerToken, sessionToken);
    },
  };
}

/**
 * Host-header allowlist — the DNS-rebinding gate. A malicious page at
 * attacker.com can point its own DNS name at 127.0.0.1 and fetch
 * http://attacker.com:<port>/…; the socket connects to us, but the Host
 * header gives the game away. Only loopback spellings of ourselves pass.
 */
export function isAllowedHost(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/**
 * Origin gate for state-changing requests. Browsers attach Origin to all
 * cross-origin requests (and same-origin non-GETs); a matching loopback
 * origin — or none at all (curl, same-origin GET) — passes. Anything else
 * is another site driving the user's browser at us.
 */
export function isAllowedOrigin(originHeader: string | null, port: number): boolean {
  if (originHeader === null) return true;
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(originHeader.toLowerCase());
}
