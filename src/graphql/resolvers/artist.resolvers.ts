import { Context } from './context.js';
import { suggestArtists } from '../../modules/artists/artist.service.js';
import { parseArtists, formatArtistDisplay } from '../../utils/artists.js';

const MAX_PARSE_INPUT = 1000;

export const artistResolvers = {
  Query: {
    // The user id comes from the authenticated context only; the query has no way
    // to name another account, so there is nothing to authorise per-record.
    myArtistSuggestions: async (
      _root: unknown,
      { prefix, limit, offset }: { prefix: string; limit?: number | null; offset?: number | null },
      context: Context,
    ) => {
      if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return suggestArtists(context.userId, prefix, limit ?? undefined, offset ?? undefined);
    },

    parseArtists: (_root: unknown, { artist, title }: { artist: string; title?: string | null }) => {
      const parsed = parseArtists(artist.slice(0, MAX_PARSE_INPUT), title == null ? undefined : title.slice(0, MAX_PARSE_INPUT));
      return {
        artists: parsed.credits,
        title: parsed.title,
        flags: parsed.flags,
        display: formatArtistDisplay(parsed.credits),
      };
    },
  },
};
