import type { ServiceResult, ProjectPublic } from '../../types/index.js';
import Project from './project.model.js';
import ProjectFork from './projectFork.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import { withTransaction } from '../../db/transaction.js';
import { upsertSocial } from '../notifications/notifications.service.js';
import User from '../../db/user.model.js';
import { getIO } from '../../socket/socket.manager.js';

export async function getShareProject(projectId: string): Promise<ProjectPublic | null> {
  const project = await Project.findOne({ projectId })
    .populate('uploadId')
    .populate('userId', 'accountName displayName avatarUrl role isVerified ban');

  if (!project || project.public === false) return null;

  const lyrics = await Lyrics.findOne({ projectId });

  const pub = (project as unknown as { toPublic(): Record<string, unknown> }).toPublic();

  // Use model toPublic for consistency and mandatory fields
  if (project.uploadId && typeof project.uploadId === 'object') {
    const uploadDoc = project.uploadId as unknown as { _id?: { toString(): string }; id?: string; toPublic?: () => unknown; source?: string; fileName?: string; title?: string; youtubeUrl?: string; cloudinaryUrl?: string; spotifyTrackId?: string; artist?: string; duration?: number };
    pub.upload = typeof uploadDoc.toPublic === 'function' ? uploadDoc.toPublic() : {
      id: uploadDoc._id?.toString() || uploadDoc.id,
      source: uploadDoc.source,
      fileName: uploadDoc.fileName || '',
      title: uploadDoc.title || '',
      youtubeUrl: uploadDoc.youtubeUrl,
      cloudinaryUrl: uploadDoc.cloudinaryUrl,
      spotifyTrackId: uploadDoc.spotifyTrackId,
      artist: uploadDoc.artist,
      duration: uploadDoc.duration,
    };
  } else {
    pub.upload = null;
  }

  pub.lyrics = lyrics
    ? (lyrics as unknown as { toPublic(): unknown }).toPublic()
    : { id: null, projectId, editorMode: 'lrc', language: null, lines: [] };

  // Ensure lyrics has id and projectId (mandatory in GraphQL schema)
  if (pub.lyrics && lyrics) {
    const lyricsObj = pub.lyrics as Record<string, unknown>;
    lyricsObj.id = lyrics._id?.toString() || lyricsObj.id;
    lyricsObj.projectId = projectId;
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
  sourceProjectId: string,
  newUserId: string
): Promise<ServiceResult<{ projectId: string; url: string }>> {
  const sourceProject = await Project.findOne({ projectId: sourceProjectId }).populate('userId', 'accountName');
  if (!sourceProject) return { error: 'Source project not found', status: 404 };
  if (!sourceProject.public && !(sourceProject as unknown as { isOwnedBy(id: string): boolean }).isOwnedBy(newUserId)) return { error: 'Project not found', status: 404 };
  if (sourceProject.forksEnabled === false) throw new Error('Forking is disabled for this project');

  const MAX_PROJECTS_PER_USER = 200;

  // Note: mild TOCTOU race on concurrent creates is acceptable — overage is bounded and non-critical
  const userProjectCount = await Project.countDocuments({ userId: newUserId });
  if (userProjectCount >= MAX_PROJECTS_PER_USER) {
    return {
      error: `Project limit reached (${MAX_PROJECTS_PER_USER} max). Delete old projects to create new ones.`,
      status: 429,
    } as ServiceResult<{ projectId: string; url: string }>;
  }

  const sourceLyrics = await Lyrics.findOne({ projectId: sourceProjectId });

  // Upload upsert is idempotent and outside the transaction (shared resource)
  let newUploadId = null;
  if (sourceProject.uploadId) {
    const sourceUpload = await Upload.findById(sourceProject.uploadId);
    if (sourceUpload) {
      const srcUp = sourceUpload as unknown as Record<string, unknown>;
      const query: Record<string, unknown> = { userId: newUserId, source: srcUp.source };
      if (srcUp.source === 'cloudinary' && srcUp.cloudinaryUrl) query.cloudinaryUrl = srcUp.cloudinaryUrl;
      else if (srcUp.source === 'youtube' && srcUp.youtubeUrl) query.youtubeUrl = srcUp.youtubeUrl;
      else if (srcUp.source === 'spotify' && srcUp.spotifyTrackId) query.spotifyTrackId = srcUp.spotifyTrackId;

      const newUpload = await Upload.findOneAndUpdate(
        query,
        {
          userId: newUserId,
          source: srcUp.source,
          cloudinaryUrl: srcUp.cloudinaryUrl || null,
          publicId: srcUp.publicId || null,
          youtubeUrl: srcUp.youtubeUrl || null,
          spotifyTrackId: srcUp.spotifyTrackId || null,
          artist: srcUp.artist || null,
          fileName: srcUp.fileName || '',
          title: srcUp.title || '',
          duration: srcUp.duration || null,
        },
        { upsert: true, new: true }
      );
      newUploadId = newUpload._id;
    }
  }

  return withTransaction(async (session) => {
    const [newProject] = await Project.create([{
      userId: newUserId,
      title: `Clone - ${sourceProject.title}`,
      uploadId: newUploadId,
      state: sourceProject.state,
      metadata: sourceProject.metadata,
      readOnly: false,
      forkedFrom: {
        projectId: sourceProjectId,
        userId: (sourceProject.userId as unknown as { _id?: unknown })?._id || sourceProject.userId || null,
        accountName: (sourceProject.userId as unknown as { accountName?: string })?.accountName || null,
      },
    }], { session });

    const [newLyricsDoc] = await Lyrics.create([{
      projectId: newProject.projectId,
      editorMode: sourceLyrics?.editorMode || 'lrc',
      language: sourceLyrics?.language,
      lines: sourceLyrics?.lines || [],
    }], { session });

    newProject.lyricsId = newLyricsDoc._id;
    await newProject.save({ session });

    await Promise.all([
      Project.updateOne({ projectId: sourceProjectId }, { $inc: { forkCount: 1 } }, { session }),
      ProjectFork.create([{
        sourceProjectId,
        forkedProjectId: newProject.projectId,
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
            projectId: sourceProjectId,
            projectTitle: sourceProject.title || '',
            actorId: newUserId,
            actorAccountName: actor.accountName ?? '',
            actorAvatarUrl: actor.avatarUrl || null,
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    try {
      getIO().to(`project:${sourceProjectId}`).emit('project:forked', {
        projectId: sourceProjectId,
        forkCount: (await Project.findOne({ projectId: sourceProjectId }).select('forkCount'))?.forkCount ?? 0,
      });
    } catch { /* socket not ready */ }

    return {
      projectId: newProject.projectId,
      url: `/s/${newProject.projectId}`,
    };
  }, { operation: 'cloneProject', sourceProjectId, userId: newUserId });
}
