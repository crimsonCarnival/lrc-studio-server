import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';
import { buildOgHtml } from './og.html.js';
import { resolveOgImageUrl, getDefaultOgImageUrl } from './og.image.service.js';
import {
  buildHiddenMeta,
  getClientOrigin,
  resolveCardSourceUrl,
  resolveOgMeta,
  isValidCardId,
  type OgCardType,
} from './og.meta.service.js';
import { getOgStrings, resolveLocale, type OgLocale } from './og.strings.js';

/** `/og/meta` is a crawler surface — short enough to pick up an unpublish quickly. */
const META_CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=600';

/**
 * Card redirects are cacheable for far longer: the Cloudinary URL only changes
 * when the asset does, and `stale-while-revalidate` keeps a crawler from ever
 * waiting on this server.
 */
const IMAGE_CACHE_CONTROL = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';

const CARD_TYPES: readonly OgCardType[] = ['project', 'profile', 'list'] as const;

function resolveApiOrigin(request: FastifyRequest): string {
  const configured = getEnv().OG_API_ORIGIN;
  if (configured) return configured.replace(/\/+$/, '');
  // `trustProxy: true` is set on the Fastify instance, so protocol/host here
  // already honour X-Forwarded-*.
  return `${request.protocol}://${request.host}`;
}

function localeFromRequest(hl: unknown, request: FastifyRequest): OgLocale {
  return resolveLocale(
    typeof hl === 'string' ? hl : null,
    typeof request.headers['accept-language'] === 'string' ? request.headers['accept-language'] : null,
  );
}

/**
 * `GET /og/meta?path=&hl=` — resolved metadata for one client route.
 *
 * Contract: always 200 with a valid `OgMeta` body. A missing, unpublished or
 * hidden resource is indistinguishable from a non-existent one, and no failure
 * mode (bad input, Mongo down, a thrown builder) is allowed to produce a 4xx
 * or 5xx the middleware would have to special-case.
 */
export async function getOgMeta(
  request: FastifyRequest<{ Querystring: { path?: string; hl?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const locale = localeFromRequest(request.query?.hl, request);

  let meta;
  try {
    meta = await resolveOgMeta({
      path: request.query?.path,
      locale,
      apiOrigin: resolveApiOrigin(request),
    });
  } catch (err) {
    request.log.warn({ err }, 'og meta resolution failed');
    meta = buildHiddenMeta(locale);
  }

  reply
    .code(200)
    .header('Cache-Control', META_CACHE_CONTROL)
    .header('Vary', 'Accept-Language')
    .send(meta);
}

/**
 * `GET /og/image/:type/:id.png` — 302 to a 1200x630 Cloudinary derivative of
 * the resource's own asset, or to the brand card. Never renders or proxies an
 * image, and never reveals which of "missing", "private" and "no asset" it hit.
 */
export async function getOgImage(
  request: FastifyRequest<{ Params: { type: string; id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const fallback = getDefaultOgImageUrl();
  const redirect = (target: string): void => {
    reply
      .header('Cache-Control', IMAGE_CACHE_CONTROL)
      .redirect(target, 302);
  };

  const { type } = request.params;
  // `:id` arrives as `<id>.png`; the extension is cosmetic (crawlers and
  // previews prefer an image-looking URL) and is not part of the identifier.
  const id = request.params.id.replace(/\.png$/i, '');

  if (!CARD_TYPES.includes(type as OgCardType) || !isValidCardId(type as OgCardType, id)) {
    return redirect(fallback);
  }

  try {
    const source = await resolveCardSourceUrl(type as OgCardType, id);
    return redirect(resolveOgImageUrl(source));
  } catch (err) {
    request.log.warn({ err }, 'og image resolution failed');
    return redirect(fallback);
  }
}

/**
 * `GET /og/project/:publicId` — the original standalone crawler page. Superseded
 * by `/og/meta` + the Vercel middleware, kept because links shared before that
 * existed still point at it.
 */
export async function getProjectOgPage(
  request: FastifyRequest<{ Params: { publicId: string }; Querystring: { hl?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const locale = localeFromRequest(request.query?.hl, request);
  const strings = getOgStrings(locale);
  const { publicId } = request.params;
  const nonce = crypto.randomBytes(16).toString('base64');
  const clientOrigin = getClientOrigin();

  const meta = await resolveOgMeta({
    path: `/project/${publicId}`,
    locale,
    apiOrigin: resolveApiOrigin(request),
  });

  const hidden = meta.robots !== 'index,follow';
  const redirectUrl = hidden ? `${clientOrigin}/` : meta.canonical;

  const send = (status: number, body: string): void => {
    reply
      .code(status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .header('Vary', 'Accept-Language')
      // Lock down this server-rendered HTML: no resources load, the only script
      // permitted is the nonce'd redirect. Defends the route even if an input
      // sanitiser is ever bypassed (the global helmet CSP is disabled).
      .header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
      )
      .send(body);
  };

  if (hidden) {
    // 404 for both "no such project" and "not published", with a noindex
    // branded body — same status, same bytes, so the route cannot be used to
    // probe which projects exist.
    return send(404, buildOgHtml({
      meta,
      redirectUrl,
      nonce,
      lang: locale,
      linkLabel: strings.viewOnSite,
    }));
  }

  // BEHAVIOUR CHANGE: the old page's description was always
  // `Synced lyrics by <owner>`. It now carries the same lyric-excerpt /
  // project-description text `/og/meta` returns, so the two crawler surfaces
  // cannot describe the same project differently.
  return send(200, buildOgHtml({
    meta,
    redirectUrl,
    nonce,
    lang: locale,
    linkLabel: strings.viewOnSite,
  }));
}
