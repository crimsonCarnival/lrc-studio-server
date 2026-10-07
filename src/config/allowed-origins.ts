/**
 * Parses CORS_ORIGIN into the exact strings an `Origin` header can contain.
 *
 * An `Origin` is scheme + host + optional port and never has a trailing slash
 * or a path, so a configured value of `https://example.com/` can never match
 * one and silently blocks every request from that site. Dashboard UIs also
 * frequently store values with surrounding quotes. Both are normalised away
 * here rather than being treated as the operator's problem, because the
 * failure mode is a total, silent CORS outage that looks like a code bug.
 *
 * Shared by the HTTP CORS plugin and the Socket.IO server so the two can never
 * disagree about which origins are allowed.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(value => value.trim())
    // Strip a wrapping pair of single or double quotes.
    .map(value => value.replace(/^['"]|['"]$/g, '').trim())
    // Strip any trailing slashes; an Origin header never carries one.
    .map(value => value.replace(/\/+$/, ''))
    .filter(value => value.length > 0);
}


/**
 * Reduces one configured URL/origin to its canonical `scheme://host[:port]`,
 * or null when it is not a usable http(s) URL. Never throws: a single bad
 * entry in APP_URL/CORS_ORIGIN must not take down an endpoint.
 */
export function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Origins the OAuth flow may hand an OTT back to (`appOrigin`). This is the
 * union of every configured frontend origin: all of APP_URL and all of
 * CORS_ORIGIN, since an origin trusted to make credentialed API calls is
 * equally trusted to receive the sign-in result. Exact match only — never
 * reflect the request, never wildcard a parent domain.
 */
export function buildAppOriginAllowlist(env: { APP_URLS: string[]; CORS_ORIGIN: string }): Set<string> {
  const entries = [...parseAllowedOrigins(env.APP_URLS.join(',')), ...parseAllowedOrigins(env.CORS_ORIGIN)];
  const origins = entries.map(toOrigin).filter((o): o is string => o !== null);
  return new Set(origins);
}

/** Returns the canonical origin when `requested` is allowlisted, else undefined. */
export function resolveAllowedAppOrigin(
  requested: string | undefined,
  env: { APP_URLS: string[]; CORS_ORIGIN: string },
): string | undefined {
  if (!requested) return undefined;
  const origin = toOrigin(requested);
  return origin && buildAppOriginAllowlist(env).has(origin) ? origin : undefined;
}
