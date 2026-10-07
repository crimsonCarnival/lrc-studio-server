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
