/**
 * JSON Schema for the crawler-facing Open Graph routes.
 *
 * These schemas deliberately only bound the SIZE of each input — they do not
 * enforce its shape. Every `/og` route has to answer a crawler with something
 * valid no matter what it is handed: `/og/meta` always returns a 200 `OgMeta`
 * body and `/og/image` always redirects to a card. An AJV failure here would
 * short-circuit that into a 400 from the global error handler, so the semantic
 * checks (is this a known card type, is this a plausible id, does this path map
 * to a route) live in the controller and service, which can fall back to the
 * branded/hidden response instead of erroring.
 *
 * The caps are the actual security control: they stop an unauthenticated caller
 * from pushing megabyte querystrings through AJV and into Mongo lookups.
 */

/** Generous enough for any real client route plus its query, short enough to bound work. */
const MAX_PATH_LENGTH = 2048;

/** `en`, `es`, or a full Accept-Language-ish tag such as `es-CO`. */
const MAX_LOCALE_LENGTH = 16;

/** `<id>.png`, where the id is a nanoid(10) publicId, an accountName or a playlist id. */
const MAX_CARD_ID_LENGTH = 128;

/** A card type segment (`project` | `profile` | `list`); validated for real in the controller. */
const MAX_CARD_TYPE_LENGTH = 32;

export const ogMetaQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      // Optional on purpose: a missing path is a generic branded card, not a 400.
      path: { type: 'string', maxLength: MAX_PATH_LENGTH },
      hl: { type: 'string', maxLength: MAX_LOCALE_LENGTH },
    },
    additionalProperties: false,
  },
};

export const ogImageParamsSchema = {
  params: {
    type: 'object',
    properties: {
      type: { type: 'string', maxLength: MAX_CARD_TYPE_LENGTH },
      id: { type: 'string', maxLength: MAX_CARD_ID_LENGTH },
    },
    required: ['type', 'id'],
    additionalProperties: false,
  },
};

export const ogProjectPageSchema = {
  params: {
    type: 'object',
    properties: {
      publicId: { type: 'string', maxLength: MAX_CARD_ID_LENGTH },
    },
    required: ['publicId'],
    additionalProperties: false,
  },
  querystring: {
    type: 'object',
    properties: {
      hl: { type: 'string', maxLength: MAX_LOCALE_LENGTH },
    },
    additionalProperties: false,
  },
};
