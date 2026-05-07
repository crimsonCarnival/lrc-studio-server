import type { ServiceResult, ProjectPublic, ProjectListItem, LyricsData } from '../../types/index.js';
import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import { verifyRecaptcha } from '../auth/auth.service.js';

const ANON_EXPIRY_DAYS = 7;

export async function createProject(
  data: any,
  userId: string | null | undefined,
  ip: string
): Promise<{ projectId: string; url: string } | ServiceResult> {
  const { title, uploadId, lyrics, state, metadata, readOnly, recaptchaToken } = data;

  if (!(await verifyRecaptcha(recaptchaToken, ip))) {
    return { error: 'recaptcha_failed', status: 403, code: 'recaptcha_failed' } as ServiceResult;
  }

  const projectData: Record<string, unknown> = {
    userId: userId || null,
    title: title || '',
    uploadId: uploadId || null,
    state: state || {},
    metadata: metadata || {},
    readOnly: readOnly ?? true,
    type: userId ? 'saved' : 'temporary',
  };

  if (!userId) {
    projectData.expiresAt = new Date(Date.now() + ANON_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  }

  const project = await Project.create(projectData);

  const lyricsData = {
    projectId: project.projectId,
    editorMode: lyrics?.editorMode || 'lrc',
    lines: lyrics?.lines || [],
  };
  const lyricsDoc = await Lyrics.create(lyricsData);

  project.lyricsId = lyricsDoc._id;
  await project.save();

  return {
    projectId: project.projectId,
    url: `/s/${project.projectId}`,
  };
}

export async function listProjects(userId: string): Promise<ProjectListItem[]> {
  const projects = await Project.find({ userId })
    .select('projectId title metadata uploadId readOnly createdAt updatedAt')
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
    const lineCount = lyrics?.lines?.length || 0;
    const syncedLineCount = lyrics?.lines?.filter((l: any) => l.timestamp != null).length || 0;

    return {
      id: s._id.toString(),
      projectId: s.projectId,
      title: s.title,
      metadata: s.metadata || {},
      upload: uploadObj,
      editorMode: lyrics?.editorMode || 'lrc',
      lineCount,
      syncedLineCount,
      readOnly: s.readOnly,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  });
}

export async function getProject(projectId: string): Promise<ProjectPublic | null> {
  const project = await Project.findOne({ projectId })
    .populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title');
  if (!project) return null;

  const lyrics = await Lyrics.findOne({ projectId });

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
    projectUpdate.expiresAt = null;
    projectUpdate.type = 'saved';
  }

  projectUpdate.lastEditedBy = userId || null;

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
  const allowed = ['title', 'uploadId', 'state', 'metadata', 'readOnly', 'public'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      projectUpdate[key] = data[key];
    }
  }

  if (!project.userId && userId) {
    projectUpdate.userId = userId;
    projectUpdate.expiresAt = null;
    projectUpdate.type = 'saved';
  }

  projectUpdate.lastEditedBy = userId || null;

  const hasProjectUpdate = Object.keys(projectUpdate).length > 1;

  let updatedProject = project;
  if (hasProjectUpdate) {
    updatedProject = await Project.findOneAndUpdate(
      { projectId },
      { $set: projectUpdate, $inc: { version: 1 } },
      { new: true }
    ).populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title spotifyTrackId artist') as any;
  }

  const lyricsPromise = data.lyrics !== undefined
    ? patchLyrics(projectId, data.lyrics)
    : Lyrics.findOne({ projectId });

  const updatedLyrics = await lyricsPromise;

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

  return { project: pub } as any;
}

async function patchLyrics(projectId: string, lyricsData: any): Promise<any> {
  if (lyricsData.lineIndex !== undefined && lyricsData.line !== undefined) {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(lyricsData.line)) {
      update[`lines.${lyricsData.lineIndex}.${key}`] = value;
    }
    return Lyrics.findOneAndUpdate(
      { projectId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, new: true }
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
      { upsert: true, new: true }
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
      { upsert: true, new: true }
    );
  }

  return Lyrics.findOne({ projectId });
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

  await Promise.all([
    Project.deleteOne({ projectId }),
    Lyrics.deleteOne({ projectId })
  ]);

  return {} as any;
}

export async function getShareProject(projectId: string): Promise<ProjectPublic | null> {
  const project = await Project.findOne({ projectId })
    .populate('uploadId', 'source fileName youtubeUrl cloudinaryUrl duration title');

  if (!project || project.public === false) return null;

  const lyrics = await Lyrics.findOne({ projectId });

  const pub: any = (project as any).toPublic();
  const rawUpload = pub.uploadId;

  if (rawUpload && typeof rawUpload === 'object') {
    pub.upload = {
      id: rawUpload._id?.toString?.() || rawUpload.id,
      source: rawUpload.source,
      fileName: rawUpload.fileName,
      youtubeUrl: rawUpload.youtubeUrl,
      cloudinaryUrl: rawUpload.cloudinaryUrl,
      duration: rawUpload.duration,
      title: rawUpload.title,
    };
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  pub.lyrics = lyrics
    ? { editorMode: lyrics.editorMode, language: lyrics.language || null, lines: lyrics.lines }
    : { editorMode: 'lrc', language: null, lines: [] };

  delete pub.userId;
  delete pub.lastEditedBy;
  delete pub.expiresAt;
  delete pub.deletedAt;

  return pub as ProjectPublic;
}

export async function cloneProject(
  sourceProjectId: string,
  newUserId: string
): Promise<ServiceResult<{ projectId: string; url: string }>> {
  const sourceProject = await Project.findOne({ projectId: sourceProjectId });
  if (!sourceProject) return { error: 'Source project not found', status: 404 } as any;

  const lyrics = await Lyrics.findOne({ projectId: sourceProjectId });

  const newLyricsDoc = await Lyrics.create({
    projectId: null,
    editorMode: lyrics?.editorMode || 'lrc',
    language: lyrics?.language,
    lines: lyrics?.lines || [],
  });

  let newUploadId = null;
  if (sourceProject.uploadId) {
    const sourceUpload = await Upload.findById(sourceProject.uploadId);
    if (sourceUpload) {
      const srcUp = sourceUpload as unknown as Record<string, unknown>;
      const query: Record<string, unknown> = { userId: newUserId, source: srcUp.source };
      if (srcUp.source === 'cloudinary' && srcUp.cloudinaryUrl) query.cloudinaryUrl = srcUp.cloudinaryUrl;
      else if (srcUp.source === 'youtube' && srcUp.youtubeUrl) query.youtubeUrl = srcUp.youtubeUrl;

      const newUpload = await Upload.findOneAndUpdate(
        query,
        {
          userId: newUserId,
          source: srcUp.source,
          cloudinaryUrl: srcUp.cloudinaryUrl,
          publicId: srcUp.publicId,
          youtubeUrl: srcUp.youtubeUrl,
          fileName: srcUp.fileName,
          title: srcUp.title,
          duration: srcUp.duration,
        },
        { upsert: true, new: true }
      );
      newUploadId = newUpload._id;
    }
  }

  const newProject = await Project.create({
    userId: newUserId,
    title: sourceProject.title,
    uploadId: newUploadId,
    lyricsId: newLyricsDoc._id,
    state: sourceProject.state,
    metadata: sourceProject.metadata,
    readOnly: false,
    type: 'saved',
    lastEditedBy: newUserId,
  });

  newLyricsDoc.projectId = newProject.projectId;
  await newLyricsDoc.save();

  return {
    projectId: newProject.projectId,
    url: `/s/${newProject.projectId}`,
  } as any;
}