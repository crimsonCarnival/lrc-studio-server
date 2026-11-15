import mongoose from 'mongoose';
import Project, { type IProject } from '../projects/project.model.js';
import Artist from '../artists/artist.model.js';
import ShelfVisibility from './shelf-visibility.model.js';
import { resolveProfileAccess } from '../users/profile-access.js';
import { groupShelf } from './shelf.group.js';
import type { ShelfRow, VisibilityRow } from './shelf.types.js';

export type ShelfTrackOut = { project: IProject; trackNumber: number | null };

export type ShelfAlbumOut = {
  key: string;
  title: string | null;
  year: string | null;
  isPublic: boolean;
  trackCount: number;
  coverImage: string | null;
  tracks: ShelfTrackOut[];
};

export type ShelfArtistOut = {
  id: string;
  name: string;
  isPublic: boolean;
  songCount: number;
  albumCount: number;
  coverImage: string | null;
  latestEditAt: string;
  albums: ShelfAlbumOut[];
};

const MAX_ALBUM_KEY = 500;

const editedAt = (r: ShelfRow): number => (r.contentUpdatedAt ?? r.updatedAt)?.getTime() ?? 0;

/**
 * Artists and albums for a profile. Null when the viewer may not see the
 * profile at all; [] when they blocked the owner. Project visibility comes
 * from the shared profile filter, so a hidden project never reaches grouping.
 */
export async function getShelf(
  accountName: string,
  asVisitor: boolean,
  viewerId: string | null,
  opts: { artistId?: string; withTracks: boolean }
): Promise<ShelfArtistOut[] | null> {
  const access = await resolveProfileAccess(accountName, asVisitor, viewerId);
  if (access.kind === 'missing' || access.kind === 'hidden') return null;
  if (access.kind === 'stub') return [];
  if (opts.artistId !== undefined && !mongoose.isValidObjectId(opts.artistId)) return [];

  const ownerId = access.user._id;
  const rows = await Project.find({
    ...access.projectFilter,
    kind: { $ne: 'subtitles' },
    'metadata.artists.0': { $exists: true },
  }).lean<IProject[]>();

  const shelfRows = rows as unknown as (IProject & ShelfRow)[];
  const wanted = new Set<string>();
  for (const r of shelfRows) for (const c of r.metadata?.artists ?? []) if (c.role === 'primary' && c.artistId) wanted.add(String(c.artistId));

  const [artists, visibility] = await Promise.all([
    Artist.find({ _id: { $in: [...wanted] }, userId: ownerId }).lean<{ _id: mongoose.Types.ObjectId; name: string }[]>(),
    ShelfVisibility.find({ userId: ownerId }).lean<{ artistId: mongoose.Types.ObjectId; albumKey: string | null; isPublic: boolean }[]>(),
  ]);

  const names = new Map(artists.map((a) => [String(a._id), a.name]));
  const vis: VisibilityRow[] = visibility.map((v) => ({ artistId: String(v.artistId), albumKey: v.albumKey, isPublic: v.isPublic }));

  const grouped = groupShelf(shelfRows, names, vis, { visitor: !access.isOwner });

  return grouped
    .filter((g) => opts.artistId === undefined || g.id === opts.artistId)
    .map((g) => ({
      id: g.id,
      name: g.name,
      isPublic: g.isPublic,
      songCount: g.songCount,
      albumCount: g.albums.length,
      coverImage: g.coverImage,
      latestEditAt: new Date(g.latestEditAt).toISOString(),
      albums: g.albums.map((a) => {
        const newest = [...a.rows].sort((x, y) => editedAt(y) - editedAt(x))[0];
        return {
          key: a.key,
          title: a.title,
          year: a.year,
          isPublic: a.isPublic,
          trackCount: a.rows.length,
          coverImage: newest.coverImage ?? newest.metadata?.albumArt ?? null,
          tracks: opts.withTracks ? a.rows.map((r) => ({ project: r, trackNumber: r.metadata?.trackNumber ?? null })) : [],
        };
      }),
    }));
}

export async function setShelfVisibility(
  userId: string,
  artistId: string,
  albumKey: string | null,
  isPublic: boolean
): Promise<void> {
  if (albumKey !== null && albumKey.length > MAX_ALBUM_KEY) {
    throw Object.assign(new Error('bad_album_key'), { status: 400, extensions: { code: 'bad_album_key' } });
  }
  // Same 404 for a malformed id and a foreign one, so ids cannot be probed.
  const owned = mongoose.isValidObjectId(artistId) && (await Artist.exists({ _id: artistId, userId }));
  if (!owned) throw Object.assign(new Error('not_found'), { status: 404 });

  await ShelfVisibility.updateOne(
    { userId, artistId, albumKey },
    { $set: { isPublic } },
    { upsert: true }
  );
}
