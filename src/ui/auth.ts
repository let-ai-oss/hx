// Auth for the local HX Client UI server.
//
// Model: `hx ui` mints a single-use, short-TTL LAUNCH token and opens the
// browser at http://localhost:<port>/#k=<launch-token>. The SPA exchanges the
// fragment (which never travels on the wire) via POST /api/auth for a SESSION
// token it keeps in sessionStorage and sends on every /api call in the
// `x-hx-ui-token` header. A custom header is deliberately used instead of a
// cookie: cookies on localhost are shared across every port (any other local
// dev server would receive them), while a header bound to the page's origin
// is port-scoped and CSRF-proof by construction.
//
// The launch token is SINGLE-USE and short-lived: the browser opener passes it
// as a process argv (world-readable via /proc on a shared host), so it must not
// be replayable — the first exchange consumes it, and it expires quickly if
// never consumed. It is minted fresh per browser-open, never reused.
//
// Ownership (the "is that instance really mine?" question a second `hx ui`
// asks) rides a separate per-run OWNER KEY that lives ONLY in the 0600
// server-info file — never in a URL or argv. The reuse handshake proves
// knowledge of it with HMACs over a fresh nonce (both directions), so no secret
// is disclosed to a port-squatter and the squatter can't impersonate us.

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time string comparison. Hashing both sides first makes the
 * comparison length-independent, so nothing about the expected value (not even
 * its length) leaks through timing.
 */
export function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// HMAC labels for the reuse handshake — distinct so a client proof can never be
// replayed as a server proof (or vice versa).
export const CLIENT_PROOF_LABEL = "hx-ui-reissue";
export const SERVER_PROOF_LABEL = "hx-ui-instance";

/** HMAC-SHA256(ownerKey, "<label>:<nonce>") as base64url. */
export function hmacProof(ownerKey: string, label: string, nonce: string): string {
  return createHmac("sha256", ownerKey).update(`${label}:${nonce}`).digest("base64url");
}

const LAUNCH_TTL_MS = 5 * 60_000;

export interface UiAuth {
  /** Same-uid ownership secret; lives only in the 0600 server-info file. */
  readonly ownerKey: string;
  readonly sessionToken: string;
  /** Mint a fresh single-use, short-TTL launch token for one browser open. */
  mintLaunchToken(nowMs?: number): string;
  /** POST /api/auth: consume a launch token (once), return the session token. */
  exchange(launchToken: string | null, nowMs?: number): string | null;
  /** Gate for /api/* requests: the x-hx-ui-token header value. */
  isValidSession(headerToken: string | null): boolean;
  /** Reuse handshake: verify a caller's proof-of-ownerKey over their nonce. */
  verifyOwnerProof(nonce: string, proof: string | null): boolean;
  /** Reuse handshake: this server's proof-of-ownerKey over the caller's nonce. */
  serverProof(nonce: string): string;
}

export function createUiAuth(): UiAuth {
  const ownerKey = mintToken();
  const sessionToken = mintToken();
  // Outstanding launch tokens: sha256 digest → expiry. Storing the digest (not
  // the token) keeps comparison constant-time and never holds the raw secret.
  const launch: { digest: Buffer; expiresAt: number }[] = [];

  const sweep = (nowMs: number): void => {
    for (let i = launch.length - 1; i >= 0; i--) {
      if (launch[i]!.expiresAt <= nowMs) launch.splice(i, 1);
    }
  };

  return {
    ownerKey,
    sessionToken,
    mintLaunchToken(nowMs = Date.now()) {
      sweep(nowMs);
      const token = mintToken();
      launch.push({
        digest: createHash("sha256").update(token).digest(),
        expiresAt: nowMs + LAUNCH_TTL_MS,
      });
      return token;
    },
    exchange(candidate, nowMs = Date.now()) {
      if (!candidate) return null;
      const cand = createHash("sha256").update(candidate).digest();
      for (let i = 0; i < launch.length; i++) {
        const entry = launch[i]!;
        if (entry.expiresAt <= nowMs) continue;
        if (timingSafeEqual(cand, entry.digest)) {
          launch.splice(i, 1); // single-use
          return sessionToken;
        }
      }
      return null;
    },
    isValidSession(headerToken) {
      return tokensMatch(headerToken, sessionToken);
    },
    verifyOwnerProof(nonce, proof) {
      return tokensMatch(proof, hmacProof(ownerKey, CLIENT_PROOF_LABEL, nonce));
    },
    serverProof(nonce) {
      return hmacProof(ownerKey, SERVER_PROOF_LABEL, nonce);
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
