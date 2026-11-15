import { Context } from './context.js';
import { getShelf, setShelfVisibility } from '../../modules/artist-shelf/shelf.service.js';

export const shelfResolvers = {
  Query: {
    artistShelf: async (
      _root: unknown,
      { accountName, asVisitor, withTracks }: { accountName: string; asVisitor?: boolean | null; withTracks?: boolean | null },
      context: Context,
    ) => (await getShelf(accountName, !!asVisitor, context.userId ?? null, { withTracks: !!withTracks })) ?? [],

    artistShelfArtist: async (
      _root: unknown,
      { accountName, artistId, asVisitor }: { accountName: string; artistId: string; asVisitor?: boolean | null },
      context: Context,
    ) => (await getShelf(accountName, !!asVisitor, context.userId ?? null, { artistId, withTracks: true }))?.[0] ?? null,
  },
  Mutation: {
    setShelfVisibility: async (
      _root: unknown,
      { artistId, albumKey, isPublic }: { artistId: string; albumKey?: string | null; isPublic: boolean },
      context: Context,
    ) => {
      if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      await setShelfVisibility(context.userId, artistId, albumKey ?? null, isPublic);
      return true;
    },
  },
};
