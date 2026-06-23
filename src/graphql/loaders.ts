import { MercuriusLoaders } from 'mercurius';
import type { MercuriusContext } from 'mercurius';
import User from '../db/user.model.js';
import Upload from '../modules/uploads/upload.model.js';
import Lyrics from '../modules/lyrics/lyrics.model.js';
import ProjectStar from '../modules/projects/projectStar.model.js';
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

export const loaders: MercuriusLoaders = {
  Project: {
    user: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: unknown; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          const user = obj.user as LoaderObj | undefined;
          if (user && (user.id || user._id)) {
            results[i] = user;
          } else {
            const id = obj.userId || obj.user; // fallback to obj.user if it's just an ID
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id);
          const users = await User.find({ _id: { $in: ids } })
            .select('accountName displayName avatarUrl role isVerified ban')
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
          const ids = toFetch.map(tf => tf.id);
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
          const ids = toFetch.map(tf => tf.id);
          const lyricsList = await Lyrics.find({ _id: { $in: ids } });
          toFetch.forEach(tf => {
            results[tf.index] = lyricsList.find(l => l._id.toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },

    // Batches isStarredByMe across all projects in a single query per request
    isStarredByMe: {
      loader: async (queries: Array<{ obj: LoaderObj }>, context: MercuriusContext & { userId?: string | null }) => {
        if (!context.userId) return queries.map(() => false);
        const publicIds = queries.map(({ obj }) => obj.publicId);
        const stars = await ProjectStar
          .find({ userId: context.userId, publicId: { $in: publicIds } })
          .select('publicId')
          .lean<Array<{ publicId: string }>>();
        const starredSet = new Set(stars.map((s) => s.publicId));
        return queries.map(({ obj }) => starredSet.has(obj.publicId as string));
      },
    },

    // Batches lineCount across all projects in a single query per request
    lineCount: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId);
        const lyricsList = await Lyrics.find(
          { publicId: { $in: publicIds } },
          { publicId: 1, sections: 1, lines: 1 }
        ).lean<LyricsCountDoc[]>();
        const map = new Map(lyricsList.map((l) => [l.publicId, l]));
        return queries.map(({ obj }) => {
          if (obj.lineCount !== undefined) return obj.lineCount;
          return countLyricLines(map.get(obj.publicId as string), false);
        });
      },
    },

    // Batches syncedLineCount across all projects in a single query per request
    syncedLineCount: {
      loader: async (queries: Array<{ obj: LoaderObj }>, _context) => {
        const publicIds = queries.map(({ obj }) => obj.publicId);
        const lyricsList = await Lyrics.find(
          { publicId: { $in: publicIds } },
          { publicId: 1, sections: 1, lines: 1 }
        ).lean<LyricsCountDoc[]>();
        const map = new Map(lyricsList.map((l) => [l.publicId, l]));
        return queries.map(({ obj }) => {
          if (obj.syncedLineCount !== undefined) return obj.syncedLineCount;
          return countLyricLines(map.get(obj.publicId as string), true);
        });
      },
    },
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
          const ids = toFetch.map(tf => tf.id);
          const users = await User.find({ _id: { $in: ids } });
          toFetch.forEach(tf => {
            results[tf.index] = users.find(u => u._id.toString() === String(tf.id)) || null;
          });
        }
        return results;
      },
    },
  },
};

