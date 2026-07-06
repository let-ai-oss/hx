// Per-repo upload route discovery (MC-2289). Before uploading a session's
// chunk, hx asks the cloud where that repo's sessions should land:
//   • { mode: "cloud" }            → upload through the cloud gateway (default)
//   • { mode: "fortress-direct" }  → upload straight to the org's Fortress with
//                                    a short-lived capability token.
// Discovery is OFF the hot path: results are cached per repo, and when the cloud
// is unreachable we reuse the last good route rather than blocking an upload.

export type Route =
  | { mode: "cloud" }
  | { mode: "fortress-direct"; gatewayUrl: string; token: string; expiresAt: string };

export interface ResolveRouteOpts {
  repo: string;
  gatewayBaseUrl: string;
  accessToken: string;
  fetcher?: typeof fetch;
  cache?: Map<string, Route>;
  now?: () => number;
}

// Re-resolve a fortress route while it still has comfortably more than this much
// life left, so the capability token never expires mid-upload.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

const memo = new Map<string, Route>();

export async function resolveRoute(opts: ResolveRouteOpts): Promise<Route> {
  const { repo, gatewayBaseUrl, accessToken } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const cache = opts.cache ?? memo;
  const now = opts.now ?? Date.now;

  const cached = cache.get(repo);
  if (
    cached &&
    cached.mode === "fortress-direct" &&
    Date.parse(cached.expiresAt) - now() > REFRESH_BEFORE_EXPIRY_MS
  ) {
    return cached;
  }
  try {
    const res = await fetcher(`${gatewayBaseUrl}/route?repo=${encodeURIComponent(repo)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return cached ?? { mode: "cloud" };
    const route = (await res.json()) as Route;
    cache.set(repo, route);
    return route;
  } catch {
    // Cloud unreachable — discovery is not on the hot path; use the last good
    // route so uploads keep flowing to the same place they were already going.
    return cached ?? { mode: "cloud" };
  }
}
