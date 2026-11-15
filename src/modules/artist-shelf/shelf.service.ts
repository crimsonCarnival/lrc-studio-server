import mongoose from 'mongoose';
import Project, { type IProject } from '../projects/project.model.js';
import Artist from '../artists/artist.model.js';
import ShelfVisibility from './shelf-visibility.model.js';
import { artistKey } from '../artists/artist.service.js';
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
  if (opts.artistId !== undefined && !mongoose.isObjectIdOrHexString(opts.artistId)) return [];

  const ownerId = access.user._id;
  const query = Project.find({
    ...access.projectFilter,
    kind: { $ne: 'subtitles' },
    'metadata.artists.0': { $exists: true },
  });
  // Grouping reads only ShelfRow fields; the Project GraphQL type needs whole docs when tracks are returned.
  if (!opts.withTracks) {
    query.select(
      '_id publicId kind title coverImage contentUpdatedAt updatedAt metadata.artists metadata.songAlbum metadata.songYear metadata.trackNumber metadata.albumArt',
    );
  }
  const rows = await query.lean<IProject[]>();

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

  const wantedId = opts.artistId?.toLowerCase();
  return grouped
    .filter((g) => wantedId === undefined || g.id === wantedId)
    .map((g) => ({
      id: g.id,
      name: g.name,
      isPublic: g.isPublic,
      songCount: g.songCount,
      // The '' bucket is singles, not an album.
      albumCount: g.albums.filter((a) => a.key !== '').length,
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
  // Grouping keys albums by artistKey(trim); store the same form or the row never matches.
  const key = albumKey === null ? null : artistKey(albumKey.trim());
  if (key !== null && key.length > MAX_ALBUM_KEY) {
    throw Object.assign(new Error('bad_album_key'), { status: 400, extensions: { code: 'bad_album_key' } });
  }
  // Same 404 for a malformed id and a foreign one, so ids cannot be probed.
  const owned = mongoose.isObjectIdOrHexString(artistId) && (await Artist.exists({ _id: artistId, userId }));
  if (!owned) throw Object.assign(new Error('not_found'), { status: 404 });

  const upsert = () => ShelfVisibility.updateOne(
    { userId, artistId, albumKey: key },
    { $set: { isPublic } },
    { upsert: true }
  );
  try {
    await upsert();
  } catch (e) {
    // Two concurrent first upserts race on the unique index; the retry then updates the winner's row.
    if ((e as { code?: number }).code !== 11000) throw e;
    await upsert();
  }
}
