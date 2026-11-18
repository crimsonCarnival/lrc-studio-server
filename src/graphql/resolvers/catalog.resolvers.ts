import mercurius from 'mercurius';
import mongoose from 'mongoose';
import { Context } from './context.js';
import { requirePermission } from './auth-guards.js';
import User from '../../modules/users/user.model.js';
import type { IUser } from '../../modules/users/user.model.js';
import {
  submitCatalogArtist,
  submitCatalogAlbum,
  updateMyPendingEntry,
  withdrawMyPendingEntry,
  listMySubmissions,
  isError,
  type CatalogError,
} from '../../modules/catalog/catalog.service.js';
import type { CatalogImageSource } from '../../modules/catalog/catalog.types.js';
import { reviewCatalogEntry } from '../../modules/catalog/catalog.review.service.js';
import {
  adminCreateCatalogArtist,
  adminCreateCatalogAlbum,
  adminUpdateCatalogEntry,
  adminDeleteCatalogEntry,
} from '../../modules/catalog/catalog.admin.service.js';
import { detectAlbums, approveDetectedAlbum, dismissDetectedAlbum } from '../../modules/catalog/catalog.detect.service.js';
import { listReviewQueue, listApprovedArtists, listApprovedAlbums, getPublicArtistBySlug } from '../../modules/catalog/catalog.query.service.js';

type Kind = 'artist' | 'album';

/** Identity comes from the authenticated context only; a banned-only context is anonymous here. */
function requireUser(context: Context): string {
  if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return context.userId;
}

/** Same step-up the other destructive admin mutations require (see requireSudo in user.resolvers). */
function requireSudo(context: Context): void {
  if (context.hasSudo !== true) throw new mercurius.ErrorWithProps('sudo_required', { code: 'SUDO_REQUIRED' });
}

/** Service failures become typed GraphQL errors; a failing mutation must throw, never resolve false. */
function raise(err: CatalogError): never {
  // Forbidden shares the generic code the client already branches on for staff gates.
  const code = err.code === 'CATALOG_FORBIDDEN' ? 'forbidden' : err.code.toLowerCase();
  throw new mercurius.ErrorWithProps(err.error, {
    code,
    ...(err.code === 'CATALOG_DUPLICATE' && err.existing ? { existing: err.existing } : {}),
  });
}

function unwrap<T>(result: T | CatalogError): T {
  if (isError(result)) raise(result);
  return result;
}

const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

type EntryFields = { name?: string | null; title?: string | null; bio?: string | null; imageUrl?: string | null; year?: string | null; coverUrl?: string | null; disambiguation?: string | null; imageSource?: CatalogImageSource | null; imageSourceUrl?: string | null };
// GraphQL null on a text field means "not provided"; only the image and year fields can be cleared with null.
const text = (v: string | null | undefined): string | undefined => v ?? undefined;
const artistPatch = (a: EntryFields) =>
  defined({ name: text(a.name), bio: text(a.bio), imageUrl: a.imageUrl, imageSource: a.imageSource, imageSourceUrl: a.imageSourceUrl, disambiguation: text(a.disambiguation) });
const albumPatch = (a: EntryFields) => defined({ title: text(a.title), year: a.year, coverUrl: a.coverUrl });

const iso = (d: Date | string | undefined | null): string | null => (d ? new Date(d).toISOString() : null);
const rowId = (row: { _id?: unknown; id?: string }): string => String(row._id ?? row.id);

const entryFields = {
  id: rowId,
  createdAt: (row: { createdAt?: Date }) => iso(row.createdAt),
  updatedAt: (row: { updatedAt?: Date }) => iso(row.updatedAt),
  // Rows are lean or hydrated; reviewNote reaches only the submitter and reviewers through the queries above.
  submittedBy: async (row: { submittedBy?: unknown }) => {
    const raw = row.submittedBy as { _id?: unknown } | string | null | undefined;
    const id = raw && typeof raw === 'object' && '_id' in raw ? String(raw._id) : raw ? String(raw) : null;
    if (!id || !mongoose.isValidObjectId(id)) return null;
    const user = await User.findById(id).select('accountName displayName avatarUrl role').lean<IUser>();
    if (!user) return null;
    return {
      id,
      accountName: user.accountName,
      displayName: user.displayName ?? null,
      avatarUrl: user.avatarUrl ?? null,
      staffRole: user.role && user.role !== 'user' ? user.role : null,
    };
  },
};

export const catalogResolvers = {
  Query: {
    catalogArtist: async (_root: unknown, { slug }: { slug: string }) => getPublicArtistBySlug(slug),

    myCatalogSubmissions: async (_root: unknown, _args: unknown, context: Context) => listMySubmissions(requireUser(context)),

    catalogReviewQueue: async (_root: unknown, _args: unknown, context: Context) => {
      await requirePermission(context, 'catalog.review');
      return listReviewQueue();
    },

    catalogAdminArtists: async (_root: unknown, args: { query?: string | null; offset?: number | null; limit?: number | null }, context: Context) => {
      await requirePermission(context, 'catalog.manage');
      return listApprovedArtists(args);
    },

    catalogAdminAlbums: async (_root: unknown, { artistId }: { artistId: string }, context: Context) => {
      await requirePermission(context, 'catalog.manage');
      return listApprovedAlbums(artistId);
    },

    catalogDetectAlbums: async (_root: unknown, { artistId }: { artistId: string }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      return unwrap(await detectAlbums(userId, artistId));
    },
  },

  Mutation: {
    submitCatalogArtist: async (_root: unknown, args: { name: string; bio?: string | null; imageUrl?: string | null }, context: Context) =>
      unwrap(await submitCatalogArtist(requireUser(context), { name: args.name, bio: text(args.bio), imageUrl: args.imageUrl })).artist,

    submitCatalogAlbum: async (_root: unknown, args: { artistId: string; title: string; year?: string | null; coverUrl?: string | null }, context: Context) =>
      unwrap(await submitCatalogAlbum(requireUser(context), args)).album,

    updateMyCatalogEntry: async (_root: unknown, args: EntryFields & { kind: Kind; id: string }, context: Context) => {
      const userId = requireUser(context);
      if (args.kind === 'artist') unwrap(await updateMyPendingEntry(userId, 'artist', args.id, artistPatch(args)));
      else unwrap(await updateMyPendingEntry(userId, 'album', args.id, albumPatch(args)));
      return true;
    },

    withdrawMyCatalogEntry: async (_root: unknown, { kind, id }: { kind: Kind; id: string }, context: Context) => {
      unwrap(await withdrawMyPendingEntry(requireUser(context), kind, id));
      return true;
    },

    reviewCatalogEntry: async (
      _root: unknown,
      args: { kind: Kind; id: string; decision: 'approve' | 'reject'; note?: string | null; expectedUpdatedAt?: string | null },
      context: Context,
    ) => {
      // Fast path only: the service re-reads permissions from the DB.
      const { userId, permissions } = await requirePermission(context, 'catalog.review');
      let expectedUpdatedAt: Date | undefined;
      if (args.expectedUpdatedAt) {
        expectedUpdatedAt = new Date(args.expectedUpdatedAt);
        if (Number.isNaN(expectedUpdatedAt.getTime())) {
          throw new mercurius.ErrorWithProps('Invalid expectedUpdatedAt', { code: 'catalog_invalid_input' });
        }
      }
      unwrap(await reviewCatalogEntry({ userId, permissions }, args.kind, args.id, args.decision, args.note ?? undefined, { expectedUpdatedAt }));
      return true;
    },

    adminCreateCatalogArtist: async (_root: unknown, args: { name: string; disambiguation?: string | null; bio?: string | null; imageUrl?: string | null; imageSource?: CatalogImageSource | null; imageSourceUrl?: string | null }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      return unwrap(await adminCreateCatalogArtist(userId, { name: args.name, ...artistPatch({ ...args, name: undefined }) })).artist;
    },

    adminCreateCatalogAlbum: async (_root: unknown, args: { artistId: string; title: string; year?: string | null; coverUrl?: string | null }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      return unwrap(await adminCreateCatalogAlbum(userId, args)).album;
    },

    adminUpdateCatalogEntry: async (_root: unknown, args: EntryFields & { kind: Kind; id: string }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      if (args.kind === 'artist') unwrap(await adminUpdateCatalogEntry(userId, 'artist', args.id, artistPatch(args)));
      else unwrap(await adminUpdateCatalogEntry(userId, 'album', args.id, albumPatch(args)));
      return true;
    },

    adminDeleteCatalogEntry: async (_root: unknown, args: { kind: Kind; id: string; revokeCredit?: boolean | null }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      requireSudo(context);
      unwrap(await adminDeleteCatalogEntry(userId, args.kind, args.id, { revokeCredit: args.revokeCredit === true }));
      return true;
    },

    // No sudo: nothing is deleted.
    approveDetectedAlbum: async (_root: unknown, args: { artistId: string; title: string; year?: string | null }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      return unwrap(await approveDetectedAlbum(userId, args.artistId, args.title, args.year ?? null)).album;
    },

    dismissDetectedAlbum: async (_root: unknown, args: { artistId: string; key: string }, context: Context) => {
      const { userId } = await requirePermission(context, 'catalog.manage');
      unwrap(await dismissDetectedAlbum(userId, args.artistId, args.key));
      return true;
    },
  },

  CatalogArtist: entryFields,
  CatalogAlbum: { ...entryFields, artistId: (row: { artistId?: unknown }) => String(row.artistId) },
};
