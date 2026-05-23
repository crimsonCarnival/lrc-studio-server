import type { ServiceResult, ProjectPublic } from '../../types/index.js';
import Project from './project.model.js';
import ProjectFork from './projectFork.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import { withTransaction } from '../../db/transaction.js';

export async function getShareProject(projectId: string): Promise<ProjectPublic | null> {
  const project = await Project.findOne({ projectId })
    .populate('uploadId')
    .populate('userId', 'accountName displayName avatarUrl role isVerified ban');

  if (!project || project.public === false) return null;

  const lyrics = await Lyrics.findOne({ projectId });

  const pub: any = (project as any).toPublic();
  const rawUpload = pub.uploadId;

  // Use model toPublic for consistency and mandatory fields
  if (project.uploadId && typeof project.uploadId === 'object') {
    const uploadDoc = project.uploadId as any;
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
    ? (lyrics as any).toPublic()
    : { id: null, projectId, editorMode: 'lrc', language: null, lines: [] };

  // Ensure lyrics has id and projectId (mandatory in GraphQL schema)
  if (pub.lyrics && lyrics) {
    pub.lyrics.id = lyrics._id?.toString() || pub.lyrics.id;
    pub.lyrics.projectId = projectId;
  }

  if (project.userId && typeof project.userId === 'object') {
    const userDoc = project.userId as any;
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
  pub.uploadId = project.uploadId && typeof project.uploadId === 'object'
    ? (project.uploadId as any)._id?.toString() || (project.uploadId as any).id
    : (project.uploadId as any)?.toString();

  pub.lyricsId = (lyrics as any)?._id?.toString() || (project as any).lyricsId?.toString();

  delete pub.deletedAt;

  return pub as ProjectPublic;
}

export async function cloneProject(
  sourceProjectId: string,
  newUserId: string
): Promise<ServiceResult<{ projectId: string; url: string }>> {
  const sourceProject = await Project.findOne({ projectId: sourceProjectId }).populate('userId', 'accountName');
  if (!sourceProject) return { error: 'Source project not found', status: 404 } as any;
  if (!sourceProject.public && !(sourceProject as any).isOwnedBy(newUserId)) return { error: 'Project not found', status: 404 } as any;

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
        userId: (sourceProject.userId as any)?._id || sourceProject.userId || null,
        accountName: (sourceProject.userId as any)?.accountName || null,
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

    return {
      projectId: newProject.projectId,
      url: `/s/${newProject.projectId}`,
    } as any;
  }, { operation: 'cloneProject', sourceProjectId, userId: newUserId });
}
