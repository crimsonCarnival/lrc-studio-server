import type { ServiceResult, ProjectPublic, ProjectListItem } from '../../types/index.js';
import mongoose from 'mongoose';
import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import { verifyRecaptcha } from '../auth/auth.service.js';
import { logUserAction } from '../user_logs/logs.service.js';
import { withTransaction } from '../../db/transaction.js';

export async function createProject(
  data: any,
  userId: string | null | undefined,
  ip: string
): Promise<{ projectId: string; url: string } | ServiceResult> {
  const {
    title, uploadId, lyrics, state, metadata, readOnly, public: isPublic,
    recaptchaToken, ytUrl, cloudinaryUrl, cloudinaryPublicId, fileName, duration,
  } = data;

  if (!userId) {
    return { error: 'Authentication required', status: 401 } as ServiceResult;
  }

  const MAX_PROJECTS_PER_USER = 200;

  // Note: mild TOCTOU race on concurrent creates is acceptable — overage is bounded and non-critical
  const userProjectCount = await Project.countDocuments({ userId });
  if (userProjectCount >= MAX_PROJECTS_PER_USER) {
    return {
      error: `Project limit reached (${MAX_PROJECTS_PER_USER} max). Delete old projects to create new ones.`,
      status: 429,
    } as ServiceResult;
  }

  if (!(await verifyRecaptcha(recaptchaToken, ip))) {
    return { error: 'recaptcha_failed', status: 403, code: 'recaptcha_failed' } as ServiceResult;
  }

  const result = await withTransaction(async (session) => {
    // Resolve uploadId: use provided ID, or create inline from raw media URL
    let resolvedUploadId: mongoose.Types.ObjectId | null = uploadId
      ? new mongoose.Types.ObjectId(uploadId)
      : null;

    if (!resolvedUploadId && ytUrl) {
      const [upload] = await Upload.create([{
        userId: userId || null,
        source: 'youtube',
        youtubeUrl: ytUrl,
        fileName: fileName || '',
        title: title || '',
        duration: duration ?? null,
      }], { session });
      resolvedUploadId = upload._id;
    } else if (!resolvedUploadId && cloudinaryUrl) {
      const [upload] = await Upload.create([{
        userId: userId || null,
        source: 'cloudinary',
        cloudinaryUrl,
        publicId: cloudinaryPublicId || null,
        fileName: fileName || '',
        title: title || '',
        duration: duration ?? null,
      }], { session });
      resolvedUploadId = upload._id;
    }

    const [project] = await Project.create([{
      userId: userId || null,
      title: title || '',
      uploadId: resolvedUploadId,
      state: state || {},
      metadata: metadata || {},
      readOnly: readOnly ?? true,
      public: isPublic ?? true,
    }], { session });

    const [lyricsDoc] = await Lyrics.create([{
      projectId: project.projectId,
      editorMode: lyrics?.editorMode || 'lrc',
      lines: lyrics?.lines || [],
    }], { session });

    project.lyricsId = lyricsDoc._id;
    await project.save({ session });

    return { projectId: project.projectId, url: `/s/${project.projectId}` };
  }, { operation: 'createProject', userId: userId ?? null });

  if ('projectId' in result) {
    logUserAction({
      userId: userId || null,
      action: 'PROJECT_CREATE',
      entityType: 'Project',
      entityId: result.projectId,
      ip,
      deviceId: 'unknown',
      metadata: { projectId: result.projectId, title: title || '' },
    });
  }

  return result;
}

export async function listProjects(userId: string): Promise<ProjectListItem[]> {
  const projects = await Project.find({ userId })
    .select('projectId title metadata uploadId readOnly createdAt updatedAt forkedFrom forkCount starCount')
    .populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  const projectIds: string[] = projects.map((s: any) => s.projectId);
  if (projectIds.length === 0) return [];

  const lyricsMetadata = await Lyrics.aggregate([
    { $match: { projectId: { $in: projectIds } } },
    {
      $project: {
        _id: 0,
        projectId: 1,
        editorMode: 1,
        lineCount: { $size: { $ifNull: ['$lines', []] } },
        syncedLineCount: {
          $size: {
            $filter: {
              input: { $ifNull: ['$lines', []] },
              as: 'line',
              cond: { $ne: ['$$line.timestamp', null] }
            }
          }
        }
      },
    },
  ]);

  const lyricsMap = new Map<string, any>();
  for (const l of lyricsMetadata) {
    lyricsMap.set(l.projectId, l);
  }

  return projects.map((s: any) => {
    const lyrics = lyricsMap.get(s.projectId);
    const upload = s.uploadId;
    let uploadObj: any = null;
    if (upload && typeof upload === 'object') {
      uploadObj = { ...upload, id: upload._id.toString() };
      delete uploadObj._id;
    }
    return {
      id: s._id.toString(),
      projectId: s.projectId,
      title: s.title,
      metadata: s.metadata || {},
      upload: uploadObj,
      editorMode: lyrics?.editorMode || 'lrc',
      lineCount: lyrics?.lineCount ?? 0,
      syncedLineCount: lyrics?.syncedLineCount ?? 0,
      readOnly: s.readOnly,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      forkedFrom: s.forkedFrom?.projectId ? s.forkedFrom : null,
      forkCount: s.forkCount ?? 0,
      starCount: s.starCount ?? 0,
    };
  });
}

export async function getProject(projectId: string, requestingUserId?: string | null): Promise<ProjectPublic | null> {
  const [project, lyrics] = await Promise.all([
    Project.findOne({ projectId })
      .populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title'),
    Lyrics.findOne({ projectId }),
  ]);
  if (!project) return null;
  if (!project.public && !(project as any).isOwnedBy(requestingUserId)) return null;

  const pub: any = (project as any).toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    pub.upload = { ...rawUpload, id: rawUpload._id?.toString?.() || rawUpload.id };
    delete pub.upload._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  pub.lyrics = lyrics
    ? { editorMode: lyrics.editorMode, language: lyrics.language || null, lines: lyrics.lines }
    : { editorMode: 'lrc', language: null, lines: [] };

  if (pub.forkedFrom && !pub.forkedFrom.projectId) {
    pub.forkedFrom = null;
  }

  return pub as ProjectPublic;
}

export async function updateProject(
  projectId: string,
  data: any,
  userId: string | null | undefined
): Promise<ServiceResult<{ project: ProjectPublic }>> {
  const project = await Project.findOne({ projectId });
  if (!project) return { error: 'Project not found', status: 404 } as any;

  if (project.userId && !(project as any).isOwnedBy(userId)) {
    return { error: 'Not authorized to edit this project', status: 403 } as any;
  }

  const { title, uploadId, lyrics, state, metadata, readOnly } = data;

  const projectUpdate: Record<string, unknown> = {};
  if (title !== undefined) projectUpdate.title = title;
  if (uploadId !== undefined) projectUpdate.uploadId = uploadId;
  if (state !== undefined) projectUpdate.state = state;
  if (metadata !== undefined) projectUpdate.metadata = metadata;
  if (readOnly !== undefined) projectUpdate.readOnly = readOnly;
  if (data.public !== undefined) projectUpdate.public = data.public;

  if (!project.userId && userId) {
    projectUpdate.userId = userId;
  }

  const lyricsPromise = (() => {
    if (lyrics === undefined) return Lyrics.findOne({ projectId });
    const lyricsUpdate: Record<string, unknown> = {};
    if (lyrics.editorMode !== undefined) lyricsUpdate.editorMode = lyrics.editorMode;
    if (lyrics.language !== undefined) lyricsUpdate.language = lyrics.language;
    if (lyrics.lines !== undefined) lyricsUpdate.lines = lyrics.lines;
    return Lyrics.findOneAndUpdate(
      { projectId },
      { $set: lyricsUpdate, $inc: { version: 1 } },
      { upsert: true, new: true }
    );
  })();

  const [updatedProject, updatedLyrics] = await Promise.all([
    Project.findOneAndUpdate(
      { projectId },
      { $set: projectUpdate, $inc: { version: 1 } },
      { new: true }
    ).populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title spotifyTrackId artist'),
    lyricsPromise,
  ]);

  const pub: any = (updatedProject as any).toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    pub.upload = { ...rawUpload, id: rawUpload._id?.toString?.() || rawUpload.id };
    delete pub.upload._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  pub.lyrics = updatedLyrics
    ? { editorMode: updatedLyrics.editorMode, language: updatedLyrics.language || null, lines: updatedLyrics.lines }
    : { editorMode: 'lrc', language: null, lines: [] };

  logUserAction({
    userId: userId || null,
    action: 'PROJECT_UPDATE',
    entityType: 'Project',
    entityId: updatedProject?._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { projectId, fieldsUpdated: Object.keys(projectUpdate) },
  });

  return { project: pub } as any;
}

export async function patchProject(
  projectId: string,
  data: any,
  userId: string | null | undefined
): Promise<ServiceResult<{ project: ProjectPublic }>> {
  const project = await Project.findOne({ projectId })
    .populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title spotifyTrackId artist');
  if (!project) return { error: 'Project not found', status: 404 } as any;

  if (project.userId && !(project as any).isOwnedBy(userId)) {
    return { error: 'Not authorized to edit this project', status: 403 } as any;
  }

  if (data.version !== undefined && data.version !== (project as any).version) {
    return { error: 'Version conflict — reload and retry', status: 409 } as any;
  }

  const projectUpdate: Record<string, unknown> = {};
  const allowed = ['title', 'uploadId', 'state', 'metadata', 'readOnly', 'public', 'coverImage'];
  for (const key of allowed) {
    if (data[key] !== undefined) projectUpdate[key] = data[key];
  }

  if (!project.userId && userId) {
    projectUpdate.userId = userId;
  }

  const hasProjectUpdate = allowed.some(k => data[k] !== undefined) || (!project.userId && userId != null);

  const result = await withTransaction(async (session) => {
    let updatedProject = project;
    if (hasProjectUpdate) {
      updatedProject = await Project.findOneAndUpdate(
        { projectId },
        { $set: projectUpdate, $inc: { version: 1 } },
        { new: true, session }
      ).populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title spotifyTrackId artist') as any;
    }

    let updatedLyrics = null;
    if (data.lyrics !== undefined) {
      updatedLyrics = await patchLyricsWithSession(projectId, data.lyrics, session);
    } else {
      updatedLyrics = await Lyrics.findOne({ projectId }, null, { session });
    }

    return { updatedProject, updatedLyrics };
  }, { operation: 'patchProject', projectId, userId: userId ?? null });

  const { updatedProject, updatedLyrics } = result;

  const pub: any = (updatedProject as any).toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    pub.upload = { ...rawUpload, id: rawUpload._id?.toString?.() || rawUpload.id };
    delete pub.upload._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  pub.lyrics = updatedLyrics
    ? { editorMode: updatedLyrics.editorMode, language: updatedLyrics.language || null, lines: updatedLyrics.lines }
    : { editorMode: 'lrc', language: null, lines: [] };

  logUserAction({
    userId: userId || null,
    action: 'PROJECT_UPDATE',
    entityType: 'Project',
    entityId: updatedProject?._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { projectId, fieldsUpdated: Object.keys(projectUpdate) },
  });

  return { project: pub } as any;
}

async function patchLyricsWithSession(projectId: string, lyricsData: any, session: any): Promise<any> {
  if (lyricsData.lineIndex !== undefined && lyricsData.line !== undefined) {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(lyricsData.line)) {
      update[`lines.${lyricsData.lineIndex}.${key}`] = value;
    }
    return Lyrics.findOneAndUpdate(
      { projectId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    );
  }

  if (
    lyricsData.lineIndex !== undefined &&
    lyricsData.wordIndex !== undefined &&
    lyricsData.word !== undefined
  ) {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(lyricsData.word)) {
      update[`lines.${lyricsData.lineIndex}.words.${lyricsData.wordIndex}.${key}`] = value;
    }
    return Lyrics.findOneAndUpdate(
      { projectId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    );
  }

  const lyricsUpdate: Record<string, unknown> = {};
  if (lyricsData.editorMode !== undefined) lyricsUpdate.editorMode = lyricsData.editorMode;
  if (lyricsData.language !== undefined) lyricsUpdate.language = lyricsData.language;
  if (lyricsData.lines !== undefined) lyricsUpdate.lines = lyricsData.lines;

  if (Object.keys(lyricsUpdate).length > 0) {
    return Lyrics.findOneAndUpdate(
      { projectId },
      { $set: lyricsUpdate, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    );
  }

  return Lyrics.findOne({ projectId }, null, { session });
}

export async function deleteProject(
  projectId: string,
  userId: string
): Promise<ServiceResult> {
  const project = await Project.findOne({ projectId });
  if (!project) return { error: 'Project not found', status: 404 } as any;

  if (!(project as any).isOwnedBy(userId)) {
    return { error: 'Not authorized to delete this project', status: 403 } as any;
  }

  await withTransaction(async (session) => {
    await Project.deleteOne({ projectId }, { session });
    await Lyrics.deleteOne({ projectId }, { session });
  }, { operation: 'deleteProject', projectId, userId });

  logUserAction({
    userId,
    action: 'PROJECT_DELETE',
    entityType: 'Project',
    entityId: project._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { projectId },
  });

  return {} as any;
}
