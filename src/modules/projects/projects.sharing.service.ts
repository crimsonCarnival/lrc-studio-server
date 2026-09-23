import type { ServiceResult, ProjectPublic } from '../../types/index.js';
import Project from './project.model.js';
import ProjectFork from './projectFork.model.js';
import Lyrics, { migrateLinesToSections } from '../lyrics/lyrics.model.js';
import { withTransaction, TransactionError } from '../../db/transaction.js';
import { upsertSocial } from '../notifications/notifications.service.js';
import User from '../../db/user.model.js';
import { getIO } from '../../socket/socket.manager.js';

export async function getShareProject(publicId: string): Promise<ProjectPublic | null> {
  const project = await Project.findOne({ publicId })
    .populate('uploadId')
    .populate('userId', 'accountName displayName avatarUrl role isVerified ban');

  if (!project || project.public === false) return null;

  const lyrics = await Lyrics.findOne({ publicId });

  const pub = (project as unknown as { toPublic(): Record<string, unknown> }).toPublic();

  // Use model toPublic for consistency and mandatory fields
  if (project.uploadId && typeof project.uploadId === 'object') {
    const uploadDoc = project.uploadId as unknown as { _id?: { toString(): string }; id?: string; toPublic?: () => unknown; source?: string; fileName?: string; title?: string; uploadUrl?: string; duration?: number };
    pub.upload = typeof uploadDoc.toPublic === 'function' ? uploadDoc.toPublic() : {
      id: uploadDoc._id?.toString() || uploadDoc.id,
      source: uploadDoc.source,
      fileName: uploadDoc.fileName || '',
      title: uploadDoc.title || '',
      uploadUrl: uploadDoc.uploadUrl,
      duration: uploadDoc.duration,
    };
  } else {
    pub.upload = null;
  }

  pub.lyrics = lyrics
    ? (lyrics as unknown as { toPublic(): unknown }).toPublic()
    : { id: null, publicId, editorMode: 'lrc', lines: [] };

  // Ensure lyrics has id and publicId (mandatory in GraphQL schema)
  if (pub.lyrics && lyrics) {
    const lyricsObj = pub.lyrics as Record<string, unknown>;
    lyricsObj.id = lyrics._id?.toString() || lyricsObj.id;
    lyricsObj.publicId = publicId;
    pub.lyrics = lyricsObj;
  }

  if (project.userId && typeof project.userId === 'object') {
    const userDoc = project.userId as unknown as { _id?: { toString(): string }; id?: string; toPublic?: () => unknown; accountName?: string; displayName?: string | null; avatarUrl?: string; role?: string; isVerified?: boolean; ban?: { active?: boolean } };
    pub.user = typeof userDoc.toPublic === 'function' ? userDoc.toPublic() : {
      id: userDoc._id?.toString() || userDoc.id,
      accountName: userDoc.accountName,
      displayName: userDoc.displayName ?? null,
      avatarUrl: userDoc.avatarUrl,
      role: userDoc.role || 'user',
      isVerified: userDoc.isVerified || false,
      ban: { active: userDoc.ban?.active || false },
    };
    // Keep userId for the loader
    pub.userId = userDoc._id?.toString() || userDoc.id;
  } else {
    pub.user = null;
    pub.userId = null;
  }

  // Keep IDs for GraphQL loaders
  const uploadObj = project.uploadId as unknown as { _id?: { toString(): string }; id?: string; toString(): string } | undefined;
  pub.uploadId = project.uploadId && typeof project.uploadId === 'object'
    ? uploadObj?._id?.toString() || uploadObj?.id
    : uploadObj?.toString();

  pub.lyricsId = (lyrics as unknown as { _id?: { toString(): string } } | null)?._id?.toString()
    || (project as unknown as { lyricsId?: { toString(): string } }).lyricsId?.toString();

  delete pub.deletedAt;

  return pub as unknown as ProjectPublic;
}

export async function cloneProject(
  sourcepublicId: string,
  newUserId: string
): Promise<ServiceResult<{ publicId: string; url: string }>> {
  // Dedup check first — matches the ordering the resolver used to enforce before the source
  // was even fetched. Living here (not just in the resolver) means every caller gets it, and
  // moving it into the create path below closes the remaining TOCTOU race under concurrency.
  const alreadyForked = await ProjectFork.exists({ sourcepublicId, userId: newUserId });
  if (alreadyForked) return { error: 'already_forked', status: 409, code: 'already_forked' };

  const sourceProject = await Project.findOne({ publicId: sourcepublicId }).populate('userId', 'accountName');
  if (!sourceProject) return { error: 'Source project not found', status: 404, code: 'not_found' };
  if (!sourceProject.public && !(sourceProject as unknown as { isOwnedBy(id: string): boolean }).isOwnedBy(newUserId)) return { error: 'Project not found', status: 404, code: 'not_found' };
  if (sourceProject.forksEnabled === false) return { error: 'forks_disabled', status: 403, code: 'forks_disabled' };

  const MAX_PROJECTS_PER_USER = 200;

  // Note: mild TOCTOU race on concurrent creates is acceptable — overage is bounded and non-critical
  const userProjectCount = await Project.countDocuments({ userId: newUserId });
  if (userProjectCount >= MAX_PROJECTS_PER_USER) {
    return {
      error: `Project limit reached (${MAX_PROJECTS_PER_USER} max). Delete old projects to create new ones.`,
      status: 429,
      code: 'quota_exceeded',
    } as ServiceResult<{ publicId: string; url: string }>;
  }

  const sourceLyrics = await Lyrics.findOne({ publicId: sourcepublicId }).select('+lines').lean();

  try {
    return await withTransaction(async (session) => {
    const [newProject] = await Project.create([{
      userId: newUserId,
      title: `Clone - ${sourceProject.title}`,
      uploadId: sourceProject.uploadId || null,
      state: sourceProject.state,
      metadata: sourceProject.metadata,
      coverImage: sourceProject.coverImage || '',
      readOnly: false,
      forkedFrom: {
        publicId: sourcepublicId,
        userId: (sourceProject.userId as unknown as { _id?: unknown })?._id || sourceProject.userId || null,
        accountName: (sourceProject.userId as unknown as { accountName?: string })?.accountName || null,
      },
    }], { session });

    const incomingSections = sourceLyrics?.sections?.length
      ? sourceLyrics.sections
      : migrateLinesToSections(sourceLyrics?.lines || []);

    const [newLyricsDoc] = await Lyrics.create([{
      publicId: newProject.publicId,
      editorMode: sourceLyrics?.editorMode || 'lrc',
      sections: incomingSections,
    }], { session });

    newProject.lyricsId = newLyricsDoc._id;
    await newProject.save({ session });

    await Promise.all([
      Project.updateOne({ publicId: sourcepublicId }, { $inc: { forkCount: 1 } }, { session }),
      ProjectFork.create([{
        sourcepublicId,
        forkedpublicId: newProject.publicId,
        userId: newUserId,
      }], { session }),
    ]);

    const ownerIdField = sourceProject.userId as unknown as { _id?: { toString(): string } } | { toString(): string } | null;
    const ownerId = (ownerIdField as { _id?: { toString(): string } })?._id?.toString()
      || (ownerIdField as { toString(): string } | null)?.toString();
    if (ownerId) {
      User.findById(newUserId).select('accountName avatarUrl').lean<{ accountName?: string; avatarUrl?: string | null }>().then(actor => {
        if (actor) {
          upsertSocial({
            ownerId,
            type: 'fork',
            publicId: sourcepublicId,
            projectTitle: sourceProject.title || '',
            actorId: newUserId,
            actorAccountName: actor.accountName ?? '',
            actorAvatarUrl: actor.avatarUrl || null,
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    try {
      getIO().to(`project:${sourcepublicId}`).emit('project:forked', {
        publicId: sourcepublicId,
        forkCount: (await Project.findOne({ publicId: sourcepublicId }).select('forkCount'))?.forkCount ?? 0,
      });
    } catch { /* socket not ready */ }

    return {
      publicId: newProject.publicId,
      url: `/s/${newProject.publicId}`,
    };
    }, { operation: 'cloneProject', sourcepublicId, userId: newUserId });
  } catch (err) {
    // ProjectFork.create can lose the TOCTOU race to a concurrent request past the
    // exists() check above — the unique { sourcepublicId, userId } index (Task 1) then
    // rejects the insert with a duplicate-key error. withTransaction wraps whatever the
    // callback throws in a TransactionError with the original error on `.cause` (see
    // db/transaction.ts) and the transaction is rolled back, so no half-created
    // Project/Lyrics documents are left behind. Unwrap that here and translate the
    // duplicate-key case to the same already_forked shape used by the upfront check.
    if (err instanceof TransactionError && (err.cause as { code?: number } | undefined)?.code === 11000) {
      return { error: 'already_forked', status: 409, code: 'already_forked' };
    }
    throw err;
  }
}
