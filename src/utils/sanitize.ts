import sanitizeHtml from 'sanitize-html';

// sanitize-html HTML-encodes surviving text nodes. We decode the entities that
// CANNOT form markup (& " ') so common text like "Tom & Jerry" or "O'Brien"
// stays clean and doesn't double-encode under React. We deliberately do NOT
// decode &lt; / &gt; — decoding angle brackets would turn a pre-encoded payload
// like "&lt;script&gt;" back into a literal "<script>" in the stored string,
// reintroducing the exact XSS we're stripping if the value ever reaches a raw
// HTML sink. Leaving them encoded keeps the value inert in every context.
const ENTITY_DECODE: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
};

export function stripHtml(str: string): string;
export function stripHtml(str: unknown): unknown;
export function stripHtml(str: unknown): unknown {
  if (typeof str !== 'string') return str;

  // Parser-based tag removal. Unlike the previous regex blocklist, sanitize-html
  // builds an actual DOM, so it neutralizes malformed/obfuscated/nested markup
  // (e.g. `<scr<script>ipt>`, `<img src=x onerror=...>`, broken tags) that regexes
  // routinely miss. allowedTags:[] discards ALL tags; script/style content is
  // dropped entirely. Result is plain text with no markup.
  const stripped = sanitizeHtml(str, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });

  // Decode only the markup-safe entities (see ENTITY_DECODE). &lt; / &gt; stay
  // encoded so no literal tag can ever survive in the stored value.
  const decoded = stripped.replace(/&(?:amp|quot|#39);/g, (m) => ENTITY_DECODE[m] ?? m);

  return decoded.trim();
}

export function deepStripHtml<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return stripHtml(obj) as T;
  if (Array.isArray(obj)) return obj.map(deepStripHtml) as T;
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = deepStripHtml(val);
    }
    return out as T;
  }
  return obj;
}

const SAFE_URL_RE = /^https?:\/\//i;

export function sanitizeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const trimmed = url.trim();
  return SAFE_URL_RE.test(trimmed) ? trimmed : null;
}
