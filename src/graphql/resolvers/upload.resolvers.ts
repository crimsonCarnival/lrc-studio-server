import Upload from '../../modules/uploads/upload.model.js';
import Project from '../../modules/projects/project.model.js';
import { createMedia } from '../../modules/uploads/uploads.service.js';
import { Context } from './context.js';
import { canViewPrivateContent } from './auth-guards.js';
import { triggerBadgeCheck } from '../../modules/badges/badge.service.js';

export interface SaveMediaInput {
  source: string;
  uploadUrl?: string;
  title?: string;
  [key: string]: unknown;
  sizeBytes?: number;
}

export interface UploadDoc {
  _id?: { toString(): string };
  id?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

const GENERIC_TITLES = ['Sin título', 'Untitled', '無題', 'test'];
const MAX_UPLOADS_PAGE = 100;

export const uploadResolvers = {
  Query: {
    upload: async (_root: unknown, { id }: { id: string }, context: Context) => {
      const upload = await Upload.findById(id);
      if (!upload) return null;
      // Ownerless (guest, userId: null) uploads are denied too, not just
      // mismatched-owner ones — mirrors the REST twin (uploads.service.ts
      // getMedia). Guests never reach this query in practice: the `uploads`
      // list query above already returns [] when unauthenticated, so there's
      // nothing to click into. Unrelated to Project.upload (project.resolvers.ts),
      // which stays ungated since access there is already decided by the
      // project query itself (public/shared projects must still resolve media).
      if (!upload.userId || upload.userId.toString() !== context.userId) return null;
      return upload;
    },

    uploads: async (_root: unknown, { limit = 50, offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      return Upload.find({ userId: context.userId })
        .sort({ updatedAt: -1 })
        .skip(Math.max(0, offset))
        .limit(Math.min(Math.max(1, limit), MAX_UPLOADS_PAGE));
    },
  },

  Mutation: {
    // Delegates to the upload service so this path gets its field mapping and
    // URL validation (YouTube pattern, our Cloudinary account, audio extension,
    // publicId folder). The old inline version spread the raw input into the
    // upsert and accepted anonymous callers.
    saveMedia: async (_root: unknown, { input }: { input: SaveMediaInput }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      if (input.source !== 'youtube' && input.source !== 'cloudinary') throw new Error('Invalid media source');

      // Placeholder titles are treated as missing so the service fetches the real one.
      const isGeneric = !input.title || GENERIC_TITLES.includes(input.title);
      const upload = await createMedia(context.userId, { ...input, title: isGeneric ? '' : input.title });
      triggerBadgeCheck(context.userId, 'upload_create').catch(() => {});
      return upload;
    },

    deleteMedia: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await Upload.deleteOne({ _id: id, userId: context.userId });
      return result.deletedCount === 1;
    },
  },

  Upload: {
    id: (upload: UploadDoc) => upload._id?.toString() || upload.id || null,
    createdAt: (upload: UploadDoc) => upload.createdAt ? new Date(upload.createdAt).toISOString() : null,
    updatedAt: (upload: UploadDoc) => upload.updatedAt ? new Date(upload.updatedAt).toISOString() : null,
    // Forks copy the source's uploadId, so this list spans users. It is reachable
    // from any public project's `upload` edge, so private projects are filtered
    // to the viewer's own (or all, for users.view staff).
    projects: async (upload: UploadDoc, _args: unknown, context: Context) => {
      const uploadId = upload._id ?? upload.id;
      if (!uploadId) return [];
      const filter: Record<string, unknown> = { uploadId: String(uploadId) };
      if (!(await canViewPrivateContent(context))) {
        filter.$or = context.userId ? [{ public: true }, { userId: context.userId }] : [{ public: true }];
      }
      return Project.find(filter).sort({ updatedAt: -1 });
    }
  },
};
