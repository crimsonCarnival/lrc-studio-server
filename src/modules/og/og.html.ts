import type { OgMeta } from './og.meta.service.js';

/**
 * Escapes for an HTML text node *and* for a double- or single-quoted
 * attribute value, which is every context this module interpolates into.
 * `'` is escaped too: cheap, and it means a future single-quoted attribute
 * cannot silently become an injection point.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialises a string into a JavaScript literal that is safe inside a
 * `<script>` element. `JSON.stringify` handles the JS layer; `<` and `&` must
 * still be escaped because the HTML parser finds `</script` before the JS
 * parser ever sees it.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export type OgHtmlParams = {
  meta: OgMeta;
  /** Where the human visitor is sent. Must already be a server-built absolute URL. */
  redirectUrl: string;
  /** CSP nonce for the single inline redirect script. */
  nonce: string;
  /** `<html lang>`: the short tag ('en' | 'es'), not the OG locale code. */
  lang: string;
  /** Visible body copy under the (invisible, instant) redirect. */
  linkLabel: string;
};

/**
 * The standalone crawler page behind `GET /og/project/:publicId`. Predates the
 * Vercel middleware and is kept alive because links shared before it exists
 * still point here.
 */
export function buildOgHtml(params: OgHtmlParams): string {
  const { meta, redirectUrl, nonce, lang, linkLabel } = params;

  const e = escapeHtml;
  const title = e(meta.title);
  const description = e(meta.description);
  const image = e(meta.image.url);
  const url = e(redirectUrl);
  const alternates = meta.localeAlternate
    .map(code => `<meta property="og:locale:alternate" content="${e(code)}">`)
    .join('\n');

  return `<!DOCTYPE html><html lang="${e(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="robots" content="${e(meta.robots)}">
<meta name="description" content="${description}">
<meta name="theme-color" content="${e(meta.themeColor)}">
<link rel="canonical" href="${e(meta.canonical)}">
<meta property="og:type" content="${e(meta.type)}">
<meta property="og:site_name" content="${e(meta.siteName)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${e(meta.canonical)}">
<meta property="og:locale" content="${e(meta.locale)}">
${alternates}
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${e(meta.image.secureUrl)}">
<meta property="og:image:type" content="${e(meta.image.type)}">
<meta property="og:image:width" content="${meta.image.width}">
<meta property="og:image:height" content="${meta.image.height}">
<meta property="og:image:alt" content="${e(meta.image.alt)}">
${meta.music?.musician ? `<meta property="music:musician" content="${e(meta.music.musician)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${e(meta.image.alt)}">
<meta http-equiv="refresh" content="0; url=${url}">
</head><body>
<script nonce="${e(nonce)}">window.location.replace(${jsStringLiteral(redirectUrl)});</script>
<p><a href="${url}">${e(linkLabel)}</a></p>
</body></html>`;
}
