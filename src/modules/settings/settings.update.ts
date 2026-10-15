/**
 * Turns a (possibly nested, partial) settings input into dotted `$set` paths.
 *
 * `$set: { export: { stripEmptyLines: true } }` replaces the whole `export` group
 * in MongoDB, wiping every sibling the request did not mention — including
 * fields an older client has never heard of. Per-field paths update only what
 * was sent. Arrays and `null` are leaves, so a list such as `speedPresets` is
 * still replaced as a whole and `null` still clears a value.
 */
export function flattenSettingsUpdate(input: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(out, flattenSettingsUpdate(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}
