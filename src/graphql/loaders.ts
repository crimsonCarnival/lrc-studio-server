import { MercuriusLoaders } from 'mercurius';
import type { MercuriusContext } from 'mercurius';
import User from '../modules/users/user.model.js';
import Upload from '../modules/uploads/upload.model.js';
import Lyrics from '../modules/lyrics/lyrics.model.js';
import ProjectStar from '../modules/projects/project-star.model.js';
import Boost from '../modules/projects/boost.model.js';
import Follow from '../modules/users/follow.model.js';
import mongoose from 'mongoose';
import type { LineEntry, SectionEntry } from '../types/index.js';

/** Shape of a GraphQL parent object as passed by Mercurius loaders */
type LoaderObj = Record<string, unknown>;

type LyricsCountDoc = { publicId: string; sections?: SectionEntry[]; lines?: LineEntry[] };

/**
 * Count lyric lines for a lyrics document, optionally restricted to synced lines.
 * Section headers are NOT lines and must never contribute to the count. The current
 * nested format already separates markers (section wrapper) from body lines
 * (`section.lines`); the flat `lines` fallback (pre-migration docs) filters out any
 * `type === 'section'` markers so they aren't miscounted as lyric lines.
 */
function countLyricLines(doc: LyricsCountDoc | undefined, syncedOnly: boolean): number {
  if (!doc) return 0;
  const isSynced = (l: LineEntry) => l.timestamp !== null && l.timestamp !== undefined;
  if (Array.isArray(doc.sections) && doc.sections.length > 0) {
    return doc.sections.reduce((sum, sec) => {
      const body = sec.lines ?? [];
      return sum + (syncedOnly ? body.filter(isSynced).length : body.length);
    }, 0);
  }
  const flat = (doc.lines ?? []).filter((l) => l.type !== 'section');
  return syncedOnly ? flat.filter(isSynced).length : flat.length;
}

/** True when any lyric line (nested or legacy flat format) has a word with a timestamp. */
export function hasTimedWord(doc: LyricsCountDoc | undefined): boolean {
  if (!doc) return false;
  const timed = (l: LineEntry) => (l.words ?? []).some((w) => w.time !== null && w.time !== undefined);
  if (Array.isArray(doc.sections) && doc.sections.length > 0) {
    return doc.sections.some((sec) => (sec.lines ?? []).some(timed));
  }
  return (doc.lines ?? []).some(timed);
}

const STAFF_ROLES = new Set(['mod', 'admin', 'superadmin']);

/**
 * staffRole for any user-shaped parent. A parent that already carries `role` (a User
 * document) answers from it; the plain objects other resolvers build (follow lists, search,
 * leaderboard, activity actors) are looked up together, one query per request. Ordinary
 * users resolve to null, so the field never reveals more than "this account is staff".
 */
const staffRoleLoader = {
  loader: async (queries: Array<{ obj: LoaderObj }>) => {
    const idOf = (obj: LoaderObj) => String(obj.id ?? obj._id ?? '');
    const missing = [...new Set(
      queries
        .filter(({ obj }) => typeof obj.role !== 'string')
        .map(({ obj }) => idOf(obj))
        .filter((id) => mongoose.isValidObjectId(id)),
    )];

    const roles = new Map<string, string>();
    if (missing.length > 0) {
      const users = await User.find({ _id: { $in: missing } })
        .select('role')
        .lean<Array<{ _id: { toString(): string }; role?: string }>>();
      for (const u of users) if (u.role) roles.set(u._id.toString(), u.role);
    }
    return queries.map(({ obj }) => {
      const role = typeof obj.role === 'string' ? obj.role : roles.get(idOf(obj));
      return role && STAFF_ROLES.has(role) ? role : null;
    });
  },
};

export const loaders: MercuriusLoaders = {
  User: { staffRole: staffRoleLoader },
  PublicUser: { staffRole: staffRoleLoader },
  LeaderboardUser: { staffRole: staffRoleLoader },
  Project: {
    user: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: unknown; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          const user = obj.user as LoaderObj | undefined;
          const userId = obj.userId as LoaderObj | unknown;
          if (user && (user.id || user._id)) {
            results[i] = user;
          } else if (userId && typeof userId === 'object' && ((userId as LoaderObj)._id || (userId as LoaderObj).id)) {
            // `.populate('userId', ...)` (explore/sharing services) replaces userId with the
            // full user doc. Use it directly — passing it to the $in fetch below as if it
            // were a raw id matches nothing, silently nulling Project.user for every row.
            results[i] = userId as LoaderObj;
          } else {
            const id = obj.userId || obj.user; // fallback to obj.user if it's just an ID
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id as mongoose.Types.ObjectId);
          const users = await User.find({ _id: { $in: ids } })
            .select('accountName displayName avatarUrl role isVerified ban progression')
            .lean();
          toFetch.forEach(tf => {
            results[tf.index] = users.find((u) => (u._id as { toString(): string }).toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },
    upload: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: unknown; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          const upload = obj.upload as LoaderObj | undefined;
          if (upload && (upload.id || upload._id)) {
            results[i] = upload;
          } else {
            const id = obj.uploadId || obj.upload;
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id as mongoose.Types.ObjectId);
          const uploads = await Upload.find({ _id: { $in: ids } })
            .select('source fileName title uploadUrl publicId duration userId')
            .lean();
          toFetch.forEach(tf => {
            results[tf.index] = uploads.find((u) => (u._id as { toString(): string }).toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },
    lyrics: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: unknown; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          const lyrics = obj.lyrics as LoaderObj | undefined;
          if (lyrics && (lyrics.id || lyrics._id)) {
            results[i] = lyrics;
          } else {
            const id = obj.lyricsId || obj.lyrics;
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id as mongoose.Types.ObjectId);
          // No .select() here on purpose — Project.lyrics is only resolved
          // when a query actually selects it (editor/share views need the
          // whole tree), so narrowing fields would be wrong. .lean() alone
          // avoids hydrating full Mongoose documents — with per-word
          // subdocuments, this is the largest document shape in the schema
          // — when the GraphQL Lyrics resolvers below only read plain
          // fields (_id/createdAt/updatedAt), never instance methods.
          const lyricsList = await Lyrics.find({ _id: { $in: ids } }).lean();
          toFetch.forEach(tf => {
            results[tf.index] = lyricsList.find((l) => (l._id as { toString(): string }).toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },

    // Batches isStarredByMe across all projects in a single query per request
    isStarredByMe: {
      loader: async (queries: Array<{ obj: LoaderObj }>, context: MercuriusContext & { userId?: string | null }) => {
        if (!context.userId) return queries.map(() => false);
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const stars = await ProjectStar
          .find({ userId: context.userId, publicId: { $in: publicIds } })
          .select('publicId')
          .lean<Array<{ publicId: string }>>();
        const starredSet = new Set(stars.map((s) => s.publicId));
        return queries.map(({ obj }) => starredSet.has(obj.publicId as string));
      },
    },

    // Boosts live in their own collection (no counter on Project), so the count is
    // one grouped query per request rather than a countDocuments per project.
    boostCount: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const counts = await Boost.aggregate<{ _id: string; count: number }>([
          { $match: { publicId: { $in: publicIds } } },
          { $group: { _id: '$publicId', count: { $sum: 1 } } },
        ]);
        const map = new Map(counts.map((c) => [c._id, c.count]));
        return queries.map(({ obj }) => map.get(obj.publicId as string) ?? 0);
      },
    },

    isBoostedByMe: {
      loader: async (queries: Array<{ obj: LoaderObj }>, context: MercuriusContext & { userId?: string | null }) => {
        if (!context.userId) return queries.map(() => false);
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const boosts = await Boost
          .find({ userId: context.userId, publicId: { $in: publicIds } })
          .select('publicId')
          .lean<Array<{ publicId: string }>>();
        const boostedSet = new Set(boosts.map((b) => b.publicId));
        return queries.map(({ obj }) => boostedSet.has(obj.publicId as string));
      },
    },

    // Projects only the word times, not the lyric text, so a list of results stays cheap.
    hasWordSync: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const lyricsList = await Lyrics.find(
          { publicId: { $in: publicIds } },
          { publicId: 1, 'sections.lines.words.time': 1, 'lines.words.time': 1 }
        ).lean<LyricsCountDoc[]>();
        const map = new Map(lyricsList.map((l) => [l.publicId, l]));
        return queries.map(({ obj }) => hasTimedWord(map.get(obj.publicId as string)));
      },
    },

    // Batches lineCount across all projects in a single query per request.
    // Projects only what countLyricLines actually reads (array length +
    // timestamp, plus `type` to skip legacy section-marker rows in the flat
    // fallback) — `sections: 1, lines: 1` used to pull every line's full
    // text/words/translations/singers, and `lines: 1` additionally
    // re-enabled the legacy flat array the schema's `select: false` exists
    // to keep off the wire by default.
    lineCount: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const lyricsList = await Lyrics.find(
          { publicId: { $in: publicIds } },
          { publicId: 1, 'sections.lines.timestamp': 1, 'lines.timestamp': 1, 'lines.type': 1 }
        ).lean<LyricsCountDoc[]>();
        const map = new Map(lyricsList.map((l) => [l.publicId, l]));
        return queries.map(({ obj }) => {
          if (obj.lineCount !== undefined) return obj.lineCount;
          return countLyricLines(map.get(obj.publicId as string), false);
        });
      },
    },

    // Same narrowing as lineCount, for the same reason.
    syncedLineCount: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId as string);
        const lyricsList = await Lyrics.find(
          { publicId: { $in: publicIds } },
          { publicId: 1, 'sections.lines.timestamp': 1, 'lines.timestamp': 1, 'lines.type': 1 }
        ).lean<LyricsCountDoc[]>();
        const map = new Map(lyricsList.map((l) => [l.publicId, l]));
        return queries.map(({ obj }) => {
          if (obj.syncedLineCount !== undefined) return obj.syncedLineCount;
          return countLyricLines(map.get(obj.publicId as string), true);
        });
      },
    },
  },
  FollowUser: {
    // FollowUser is built by several resolvers (search, suggestions, follow lists,
    // playlist owner, activity actor) and the field is non-null, so a resolver that
    // forgot to set it used to null the whole query. A value the parent already
    // carries is trusted; the rest are resolved here in one query per request.
    isFollowedByMe: {
      loader: async (queries: Array<{ obj: LoaderObj }>, context: MercuriusContext & { userId?: string | null }) => {
        const missing = queries
          .filter(({ obj }) => typeof obj.isFollowedByMe !== 'boolean')
          .map(({ obj }) => String(obj.id ?? ''))
          .filter((id) => mongoose.isValidObjectId(id));

        let followedSet = new Set<string>();
        if (context.userId && missing.length > 0) {
          const follows = await Follow
            .find({ followerId: context.userId, followingId: { $in: missing } })
            .select('followingId')
            .lean<Array<{ followingId: { toString(): string } }>>();
          followedSet = new Set(follows.map((f) => f.followingId.toString()));
        }
        return queries.map(({ obj }) =>
          typeof obj.isFollowedByMe === 'boolean' ? obj.isFollowedByMe : followedSet.has(String(obj.id ?? ''))
        );
      },
    },
    staffRole: staffRoleLoader,
  },
  Upload: {
    user: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: unknown; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          const user = obj.user as LoaderObj | undefined;
          if (user && (user.id || user._id)) {
            results[i] = user;
          } else {
            const id = obj.userId || obj.user;
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id as mongoose.Types.ObjectId);
          // Mirrors the Project.user loader above — this one had no
          // .select()/.lean() at all, hydrating full Mongoose documents
          // (including passwordHash, permissions, badges[], musicLibrary[])
          // into the resolver layer just to resolve a public-facing field.
          const users = await User.find({ _id: { $in: ids } })
            .select('accountName displayName avatarUrl role isVerified ban progression')
            .lean();
          toFetch.forEach(tf => {
            results[tf.index] = users.find((u) => (u._id as { toString(): string }).toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },
  },
};

