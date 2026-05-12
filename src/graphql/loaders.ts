import { MercuriusLoaders } from 'mercurius';
import User from '../db/user.model.js';
import Upload from '../modules/uploads/upload.model.js';
import Lyrics from '../modules/lyrics/lyrics.model.js';

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
          const users = await User.find({ _id: { $in: ids } });
          toFetch.forEach(tf => {
            results[tf.index] = users.find(u => u._id.toString() === tf.id.toString()) || null;
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
          const uploads = await Upload.find({ _id: { $in: ids } });
          toFetch.forEach(tf => {
            results[tf.index] = uploads.find(u => u._id.toString() === tf.id.toString()) || null;
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

