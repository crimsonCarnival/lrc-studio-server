import { getEnv } from '../../config/env.js';

/**
 * Social cards are served as a 302 to a Cloudinary transformation of the
 * resource's existing asset — no buffer is ever rendered here (no satori /
 * resvg / sharp). Cloudinary already holds every cover image and avatar, so
 * the card is a URL rewrite plus a redirect.
 */

/** The only host a source asset may live on. Mirrors `asr.service.ts#fetchCloudinaryAudio`. */
const CLOUDINARY_HOST = 'res.cloudinary.com';

/** Exactly the dimensions every major crawler wants for a large summary card. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = 'image/png';

/**
 * `c_fill` + explicit w/h guarantees the output is exactly 1200x630 (crops
 * rather than letterboxes), `g_auto` keeps the subject in frame, `f_png`
 * pins the format so the `.png` in our own URL is not a lie, `q_auto` lets
 * Cloudinary pick the byte budget.
 */
const OG_TRANSFORMATION = 'c_fill,w_1200,h_630,g_auto,f_png,q_auto';

/** `v1234567890` — a Cloudinary version segment, not a transformation. */
const VERSION_SEGMENT = /^v\d+$/;

/** A transformation segment: comma-joined `key_value` pairs, e.g. `c_scale,w_400`. */
const TRANSFORMATION_SEGMENT = /^[a-z]{1,3}_[^/]*$/;

export const DEFAULT_OG_IMAGE_FALLBACK = 'https://www.lrcstudio.app/og-default.png';

export function getDefaultOgImageUrl(): string {
  return getEnv().OG_DEFAULT_IMAGE_URL || DEFAULT_OG_IMAGE_FALLBACK;
}

/**
 * Rewrites an own-cloud Cloudinary image URL into a 1200x630 PNG derivative.
 *
 * Returns `null` — never a proxied or partially-trusted URL — when the source
 * is anything other than an `https://res.cloudinary.com/<our cloud>/image/upload/…`
 * asset. `coverImage` and `avatarUrl` are free-text columns a user can set to
 * an arbitrary value, so treating them as trusted would turn this endpoint into
 * an open redirect (and, for a crawler that follows it, an SSRF-ish fetch
 * primitive against whatever host the user named). Same guard shape as
 * `asr.service.ts#fetchCloudinaryAudio`, with the extra requirement that the
 * cloud name matches ours.
 */
export function buildOgImageUrl(
  sourceUrl: string | null | undefined,
  cloudName: string | null | undefined,
): string | null {
  if (!sourceUrl || typeof sourceUrl !== 'string' || !cloudName) return null;

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== CLOUDINARY_HOST) return null;

  // /<cloud>/image/upload/<rest>
  const segments = parsed.pathname.split('/').filter(Boolean);
  const [cloud, resourceType, deliveryType, ...rest] = segments;
  if (cloud !== cloudName) return null;
  // ASSUMPTION: only `image/upload` assets are card sources. `video/upload`
  // holds the audio files (ASR reads those) and `authenticated`/`private`
  // delivery types need a signature we would have to mint, so both fall back
  // to the brand card rather than producing a broken image.
  if (resourceType !== 'image' || deliveryType !== 'upload') return null;
  if (rest.length === 0) return null;

  // Cloudinary chains transformations left to right. An existing leading
  // transformation would run *after* ours and could undo the 1200x630, so it
  // is dropped rather than preserved.
  const tail = [...rest];
  const first = tail[0];
  if (
    tail.length > 1
    && !VERSION_SEGMENT.test(first)
    && TRANSFORMATION_SEGMENT.test(first)
    && first.includes('_')
  ) {
    tail.shift();
  }
  if (tail.length === 0) return null;

  return `https://${CLOUDINARY_HOST}/${cloud}/image/upload/${OG_TRANSFORMATION}/${tail.join('/')}`;
}

/**
 * Card URL for a resource, falling back to the brand card. Private, missing
 * and foreign-asset resources all land on the identical fallback, so the URL
 * carries no signal about which case was hit.
 */
export function resolveOgImageUrl(sourceUrl: string | null | undefined): string {
  return buildOgImageUrl(sourceUrl, getEnv().CLOUDINARY_CLOUD_NAME) ?? getDefaultOgImageUrl();
}
