import { MercuriusLoaders } from 'mercurius';
import User from '../db/user.model.js';
import Upload from '../modules/uploads/upload.model.js';
import Lyrics from '../modules/lyrics/lyrics.model.js';
import ProjectStar from '../modules/projects/projectStar.model.js';

export const loaders: MercuriusLoaders = {
  Project: {
    user: {
      loader: async (queries: Array<{ obj: any }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: any; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          if (obj.user && (obj.user.id || obj.user._id)) {
            results[i] = obj.user;
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
            results[tf.index] = users.find((u: any) => u._id.toString() === tf.id.toString()) || null;
          });
        }
        return results;
      },
    },
    upload: {
      loader: async (queries: Array<{ obj: any }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: any; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          if (obj.upload && (obj.upload.id || obj.upload._id)) {
            results[i] = obj.upload;
          } else {
            const id = obj.uploadId || obj.upload;
            if (id) toFetch.push({ id, index: i });
            else results[i] = null;
          }
        });

        if (toFetch.length > 0) {
          const ids = toFetch.map(tf => tf.id);
          const uploads = await Upload.find({ _id: { $in: ids } })
            .select('source fileName title youtubeUrl cloudinaryUrl publicId spotifyTrackId artist duration userId')
            .lean();
          toFetch.forEach(tf => {
            results[tf.index] = uploads.find((u: any) => u._id.toString() === tf.id.toString()) || null;
          });
        }
        return results;
      },
    },
    lyrics: {
      loader: async (queries: Array<{ obj: any }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: any; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          if (obj.lyrics && (obj.lyrics.id || obj.lyrics._id)) {
            results[i] = obj.lyrics;
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
            results[tf.index] = lyricsList.find(l => l._id.toString() === tf.id.toString()) || null;
          });
        }
        return results;
      },
    },

    // Batches isStarredByMe across all projects in a single query per request
    isStarredByMe: {
      loader: async (queries: Array<{ obj: any }>, context: any) => {
        if (!context.userId) return queries.map(() => false);
        const projectIds = queries.map(({ obj }) => obj.projectId);
        const stars = await ProjectStar
          .find({ userId: context.userId, projectId: { $in: projectIds } })
          .select('projectId')
          .lean();
        const starredSet = new Set((stars as any[]).map((s) => s.projectId));
        return queries.map(({ obj }) => starredSet.has(obj.projectId));
      },
    },

    // Batches lineCount across all projects in a single query per request
    lineCount: {
      loader: async (queries: Array<{ obj: any }>, _context: any) => {
        const projectIds = queries.map(({ obj }) => obj.projectId);
        const lyricsList = await Lyrics.find(
          { projectId: { $in: projectIds } },
          { projectId: 1, lines: 1 }
        ).lean();
        const map = new Map((lyricsList as any[]).map((l: any) => [l.projectId, l]));
        return queries.map(({ obj }) => {
          if (obj.lineCount !== undefined) return obj.lineCount;
          const lyrics = map.get(obj.projectId);
          return lyrics?.lines?.length ?? 0;
        });
      },
    },

    // Batches syncedLineCount across all projects in a single query per request
    syncedLineCount: {
      loader: async (queries: Array<{ obj: any }>, _context: any) => {
        const projectIds = queries.map(({ obj }) => obj.projectId);
        const lyricsList = await Lyrics.find(
          { projectId: { $in: projectIds } },
          { projectId: 1, lines: 1 }
        ).lean();
        const map = new Map((lyricsList as any[]).map((l: any) => [l.projectId, l]));
        return queries.map(({ obj }) => {
          if (obj.syncedLineCount !== undefined) return obj.syncedLineCount;
          const lyrics = map.get(obj.projectId);
          if (!lyrics?.lines) return 0;
          return (lyrics.lines as any[]).filter(
            (l: any) => l.timestamp !== null && l.timestamp !== undefined
          ).length;
        });
      },
    },
  },
  Upload: {
    user: {
      loader: async (queries: Array<{ obj: any }>, _context) => {
        const results = new Array(queries.length);
        const toFetch: Array<{ id: any; index: number }> = [];

        queries.forEach(({ obj }, i) => {
          if (obj.user && (obj.user.id || obj.user._id)) {
            results[i] = obj.user;
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
            results[tf.index] = users.find(u => u._id.toString() === tf.id.toString()) || null;
          });
        }
        return results;
      },
    },
  },
};

