import type { ServiceResult, ProjectPublic, ProjectListItem, UploadInfo, SectionEntry, LineEntry } from '../../types/index.js';
import { migrateLinesToSections } from '../lyrics/lyrics.model.js';
import { stripHtml, sanitizeUrl } from '../../utils/sanitize.js';
import mongoose from 'mongoose';
import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import { verifyRecaptcha } from '../auth/auth.service.js';
import { logUserAction } from '../user_logs/logs.service.js';
import { withTransaction } from '../../db/transaction.js';
import { writeActivity } from '../activity/activity.service.js';

// Shape of a lean project from listProjects query (populated uploadId is an object)
interface LeanProjectListItem {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  coverImage?: string;
  uploadId?: Record<string, unknown> | null;
  readOnly: boolean;
  public?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  forkedFrom?: { publicId?: string | null } | null;
  forkCount?: number;
  starCount?: number;
}

// Shape of aggregate lyrics metadata result
interface LyricsMetaItem {
  publicId: string;
  editorMode?: string;
  lineCount?: number;
  syncedLineCount?: number;
}

// Incoming request body for createProject
interface CreateProjectData {
  title?: string;
  uploadId?: string;
  lyrics?: { editorMode?: string; sections?: unknown[]; lines?: unknown[] };
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  coverImage?: string;
  readOnly?: boolean;
  public?: boolean;
  recaptchaToken?: string;
  ytUrl?: string;
  uploadUrl?: string;
  uploadPublicId?: string;
  fileName?: string;
  duration?: number;
}

// Incoming request body for updateProject / patchProject
interface UpdateProjectData {
  title?: string;
  uploadId?: string;
  lyrics?: {
    editorMode?: string;
    language?: string;
    // Full sections replace
    sections?: unknown[];
    // Positional single-line patch (sections-based)
    sectionIdx?: number;
    lineIdx?: number;
    line?: Record<string, unknown>;
    // Positional word patch (sections-based)
    wordIndex?: number;
    word?: Record<string, unknown>;
  };
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  readOnly?: boolean;
  public?: boolean;
  coverImage?: string;
  version?: number;
}

export async function createProject(
  rawData: unknown,
  userId: string | null | undefined,
  ip: string
): Promise<{ publicId: string; url: string } | ServiceResult> {
  const data = rawData as CreateProjectData;
  const {
    title, uploadId, lyrics, state, metadata, readOnly, public: isPublic,
    coverImage, recaptchaToken, ytUrl, uploadUrl, uploadPublicId, fileName, duration,
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
    } else if (!resolvedUploadId && uploadUrl) {
      const [upload] = await Upload.create([{
        userId: userId || null,
        source: 'cloudinary',
        uploadUrl,
        publicId: uploadPublicId || null,
        fileName: fileName || '',
        title: title || '',
        duration: duration ?? null,
      }], { session });
      resolvedUploadId = upload._id;
    }

    const [project] = await Project.create([{
      userId: userId || null,
      title: stripHtml(title || '').slice(0, 200),
      uploadId: resolvedUploadId,
      state: state || {},
      metadata: metadata || {},
      coverImage: coverImage ? sanitizeUrl(coverImage) : '',
      readOnly: readOnly ?? true,
      public: isPublic ?? true,
    }], { session });

    const incomingSections: SectionEntry[] = lyrics?.sections
      ? (lyrics.sections as SectionEntry[])
      : migrateLinesToSections((lyrics?.lines as LineEntry[]) || []);

    const [lyricsDoc] = await Lyrics.create([{
      publicId: project.publicId,
      editorMode: lyrics?.editorMode || 'lrc',
      sections: incomingSections,
    }], { session });

    project.lyricsId = lyricsDoc._id;
    await project.save({ session });

    return { publicId: project.publicId, url: `/s/${project.publicId}` };
  }, { operation: 'createProject', userId: userId ?? null });

  if ('publicId' in result) {
    logUserAction({
      userId: userId || null,
      action: 'PROJECT_CREATE',
      entityType: 'Project',
      entityId: result.publicId,
      ip,
      deviceId: 'unknown',
      metadata: { publicId: result.publicId, title: title || '' },
    });
  }

  return result;
}

export async function listProjects(userId: string): Promise<ProjectListItem[]> {
  const projects = await Project.find({ userId })
    .select('publicId title metadata coverImage uploadId readOnly public createdAt updatedAt forkedFrom forkCount starCount')
    .populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean<LeanProjectListItem[]>();

  const publicIds: string[] = projects.map((s) => s.publicId);
  if (publicIds.length === 0) return [];

  const lyricsMetadata = await Lyrics.aggregate<LyricsMetaItem>([
    { $match: { publicId: { $in: publicIds } } },
    {
      $project: {
        _id: 0,
        publicId: 1,
        editorMode: 1,
        lineCount: {
          $cond: {
            if: { $gt: [{ $size: { $ifNull: ['$sections', []] } }, 0] },
            then: {
              $reduce: {
                input: '$sections',
                initialValue: 0,
                in: { $add: ['$$value', { $size: { $ifNull: ['$$this.lines', []] } }] },
              },
            },
            // Fallback for pre-migration documents that still have flat $lines
            else: { $size: { $ifNull: ['$lines', []] } },
          },
        },
        syncedLineCount: {
          $cond: {
            if: { $gt: [{ $size: { $ifNull: ['$sections', []] } }, 0] },
            then: {
              $reduce: {
                input: '$sections',
                initialValue: 0,
                in: {
                  $add: ['$$value', {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$$this.lines', []] },
                        as: 'line',
                        cond: { $ne: ['$$line.timestamp', null] },
                      },
                    },
                  }],
                },
              },
            },
            else: {
              $size: {
                $filter: {
                  input: { $ifNull: ['$lines', []] },
                  as: 'line',
                  cond: { $ne: ['$$line.timestamp', null] },
                },
              },
            },
          },
        },
      },
    },
  ]);

  const lyricsMap = new Map<string, LyricsMetaItem>();
  for (const l of lyricsMetadata) {
    lyricsMap.set(l.publicId, l);
  }

  return projects.map((s) => {
    const lyrics = lyricsMap.get(s.publicId);
    const upload = s.uploadId;
    let uploadObj: UploadInfo | null = null;
    if (upload && typeof upload === 'object') {
      const { _id, ...rest } = upload as Record<string, unknown> & { _id: unknown };
      uploadObj = { ...rest, id: String(_id) } as UploadInfo;
    }
    return {
      id: s._id.toString(),
      publicId: s.publicId,
      title: s.title,
      metadata: s.metadata || {},
      coverImage: s.coverImage || '',
      upload: uploadObj,
      editorMode: lyrics?.editorMode || 'lrc',
      lineCount: lyrics?.lineCount ?? 0,
      syncedLineCount: lyrics?.syncedLineCount ?? 0,
      readOnly: s.readOnly,
      public: s.public,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      forkedFrom: s.forkedFrom?.publicId ? s.forkedFrom : null,
      forkCount: s.forkCount ?? 0,
      starCount: s.starCount ?? 0,
    };
  });
}

export async function getProject(publicId: string, requestingUserId?: string | null): Promise<ProjectPublic | null> {
  const [project, lyrics] = await Promise.all([
    Project.findOne({ publicId })
      .populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist'),
    Lyrics.findOne({ publicId }),
  ]);
  if (!project) return null;

  if (!project.public && !project.isOwnedBy(requestingUserId ?? '')) return null;

  const pub: Record<string, unknown> = project.toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    const uploadObj = rawUpload as Record<string, unknown>;
    pub.upload = { ...uploadObj, id: (uploadObj._id as { toString?(): string } | undefined)?.toString?.() || uploadObj.id };
    delete (pub.upload as Record<string, unknown>)._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  const resolvedSections = await resolveSections(lyrics);
  pub.lyrics = lyrics
    ? { editorMode: lyrics.editorMode, sections: resolvedSections }
    : { editorMode: 'lrc', sections: [] };

  if (pub.forkedFrom && !(pub.forkedFrom as Record<string, unknown>).publicId) {
    pub.forkedFrom = null;
  }

  return pub as unknown as ProjectPublic;
}

export async function updateProject(
  publicId: string,
  rawData: unknown,
  userId: string | null | undefined
): Promise<ServiceResult<{ project: ProjectPublic }>> {
  const data = rawData as UpdateProjectData;
  const project = await Project.findOne({ publicId });
  if (!project) return { error: 'Project not found', status: 404 } as ServiceResult;

  // Ownership required unconditionally — see patchProject / F7.
  if (!project.isOwnedBy(userId ?? '')) {
    return { error: 'Not authorized to edit this project', status: 403 } as ServiceResult;
  }

  const { title, uploadId, lyrics, state, metadata, readOnly } = data;

  const projectUpdate: Record<string, unknown> = {};
  if (title !== undefined) projectUpdate.title = stripHtml(title).slice(0, 200);
  if (uploadId !== undefined) projectUpdate.uploadId = uploadId;
  if (state !== undefined) projectUpdate.state = state;
  if (metadata !== undefined) projectUpdate.metadata = metadata;
  if (readOnly !== undefined) projectUpdate.readOnly = readOnly;
  if (data.public !== undefined) projectUpdate.public = data.public;
  if (data.coverImage !== undefined) projectUpdate.coverImage = sanitizeUrl(data.coverImage);

  const lyricsPromise = (() => {
    if (lyrics === undefined) return Lyrics.findOne({ publicId });
    const lyricsUpdate: Record<string, unknown> = {};
    if (lyrics.editorMode !== undefined) lyricsUpdate.editorMode = lyrics.editorMode;
    if (lyrics.language !== undefined) lyricsUpdate.language = lyrics.language;
    if (lyrics.sections !== undefined) lyricsUpdate.sections = lyrics.sections;
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: lyricsUpdate, $unset: { lines: 1 }, $inc: { version: 1 } },
      { upsert: true, new: true }
    );
  })();

  const [updatedProject, updatedLyrics] = await Promise.all([
    Project.findOneAndUpdate(
      { publicId },
      { $set: projectUpdate, $inc: { version: 1 } },
      { new: true }
    ).populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist'),
    lyricsPromise,
  ]);

  const pub: Record<string, unknown> = updatedProject!.toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    const uploadObj = rawUpload as Record<string, unknown>;
    pub.upload = { ...uploadObj, id: (uploadObj._id as { toString?(): string } | undefined)?.toString?.() || uploadObj.id };
    delete (pub.upload as Record<string, unknown>)._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  const updateSections = await resolveSections(updatedLyrics);
  pub.lyrics = updatedLyrics
    ? { editorMode: updatedLyrics.editorMode, sections: updateSections }
    : { editorMode: 'lrc', sections: [] };

  logUserAction({
    userId: userId || null,
    action: 'PROJECT_UPDATE',
    entityType: 'Project',
    entityId: updatedProject?._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { publicId, fieldsUpdated: Object.keys(projectUpdate) },
  });

  return { project: pub as unknown as ProjectPublic };
}

export async function patchProject(
  publicId: string,
  rawData: unknown,
  userId: string | null | undefined
): Promise<ServiceResult<{ project: ProjectPublic }>> {
  const data = rawData as UpdateProjectData;
  const project = await Project.findOne({ publicId })
    .populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist');
  if (!project) return { error: 'Project not found', status: 404 } as ServiceResult;

  // Require ownership unconditionally. Guest drafts live client-side (IndexedDB)
  // and are replayed as a fresh owned project via POST /projects on signup, so no
  // legitimate flow edits a server-side ownerless project. The previous
  // `project.userId && …` short-circuit let anyone edit (and silently claim) an
  // ownerless project — see F7.
  if (!project.isOwnedBy(userId ?? '')) {
    return { error: 'Not authorized to edit this project', status: 403 } as ServiceResult;
  }

  const projectWithVersion = project as unknown as { version?: number };
  if (data.version !== undefined && data.version !== projectWithVersion.version) {
    return { error: 'Version conflict — reload and retry', status: 409 } as ServiceResult;
  }

  // Detect publish transition (false → true) before the transaction overwrites the doc
  const wasPublic = !!project.public;
  const isPublishing = data.public === true && !wasPublic;

  const projectUpdate: Record<string, unknown> = {};
  const allowed = ['title', 'uploadId', 'state', 'metadata', 'readOnly', 'public', 'coverImage'] as const;
  for (const key of allowed) {
    if (data[key] !== undefined) projectUpdate[key] = data[key];
  }

  const hasProjectUpdate = allowed.some(k => data[k] !== undefined);

  const result = await withTransaction(async (session) => {
    let updatedProject = project;
    if (hasProjectUpdate) {
      const found = await Project.findOneAndUpdate(
        { publicId },
        { $set: projectUpdate, $inc: { version: 1 } },
        { new: true, session }
      ).populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist');
      if (found) updatedProject = found;
    }

    let updatedLyrics;
    if (data.lyrics !== undefined) {
      updatedLyrics = await patchLyricsWithSession(publicId, data.lyrics, session);
    } else {
      updatedLyrics = await Lyrics.findOne({ publicId }, null, { session });
    }

    return { updatedProject, updatedLyrics };
  }, { operation: 'patchProject', publicId, userId: userId ?? null });

  const { updatedProject, updatedLyrics } = result;

  const pub: Record<string, unknown> = updatedProject.toPublic();
  const rawUpload = pub.uploadId;
  if (rawUpload && typeof rawUpload === 'object') {
    const uploadObj = rawUpload as Record<string, unknown>;
    pub.upload = { ...uploadObj, id: (uploadObj._id as { toString?(): string } | undefined)?.toString?.() || uploadObj.id };
    delete (pub.upload as Record<string, unknown>)._id;
  } else {
    pub.upload = null;
  }
  delete pub.uploadId;

  const patchSections = await resolveSections(updatedLyrics);
  pub.lyrics = updatedLyrics
    ? { editorMode: updatedLyrics.editorMode, sections: patchSections }
    : { editorMode: 'lrc', sections: [] };

  logUserAction({
    userId: userId || null,
    action: 'PROJECT_UPDATE',
    entityType: 'Project',
    entityId: updatedProject?._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { publicId, fieldsUpdated: Object.keys(projectUpdate) },
  });

  if (isPublishing && userId) {
    writeActivity({
      actorId:      userId,
      type:         'project_published',
      publicId,
      projectTitle: updatedProject?.title || '',
      coverImage:   updatedProject?.coverImage || '',
    }).catch(() => {});
  }

  return { project: pub as unknown as ProjectPublic };
}

type LyricsDoc = mongoose.Document & { editorMode: string; language?: string | null; sections: unknown[]; lines?: unknown[] };

// Upper bounds prevent Mongo from materializing sparse array gaps via positional writes.
const MAX_SECTION_INDEX = 2000;
const MAX_LINE_INDEX = 10000;
const MAX_WORD_INDEX = 2000;

// Allow-lists prevent writing arbitrary nested paths.
const LINE_FIELDS = new Set(['id', 'text', 'timestamp', 'endTime', 'secondary', 'singers', 'translation', 'translations', 'words', 'secondaryWords']);
const WORD_FIELDS = new Set(['id', 'word', 'time', 'reading', 'singerIndex']);

function isValidIndex(n: unknown, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
}

async function patchLyricsWithSession(
  publicId: string,
  lyricsData: NonNullable<UpdateProjectData['lyrics']>,
  session: mongoose.ClientSession
): Promise<LyricsDoc | null> {
  // Positional single-line patch: sections.S.lines.L.field
  if (lyricsData.sectionIdx !== undefined && lyricsData.lineIdx !== undefined && lyricsData.line !== undefined && lyricsData.wordIndex === undefined) {
    if (!isValidIndex(lyricsData.sectionIdx, MAX_SECTION_INDEX) || !isValidIndex(lyricsData.lineIdx, MAX_LINE_INDEX)) {
      throw Object.assign(new Error('Invalid sectionIdx/lineIdx'), { status: 400 });
    }
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(lyricsData.line)) {
      if (!LINE_FIELDS.has(key)) continue;
      update[`sections.${lyricsData.sectionIdx}.lines.${lyricsData.lineIdx}.${key}`] = value;
    }
    if (Object.keys(update).length === 0) return Lyrics.findOne({ publicId }, null, { session }) as Promise<LyricsDoc | null>;
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    ) as Promise<LyricsDoc | null>;
  }

  // Positional word patch: sections.S.lines.L.words.W.field
  if (lyricsData.sectionIdx !== undefined && lyricsData.lineIdx !== undefined && lyricsData.wordIndex !== undefined && lyricsData.word !== undefined) {
    if (
      !isValidIndex(lyricsData.sectionIdx, MAX_SECTION_INDEX) ||
      !isValidIndex(lyricsData.lineIdx, MAX_LINE_INDEX) ||
      !isValidIndex(lyricsData.wordIndex, MAX_WORD_INDEX)
    ) {
      throw Object.assign(new Error('Invalid sectionIdx/lineIdx/wordIndex'), { status: 400 });
    }
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(lyricsData.word)) {
      if (!WORD_FIELDS.has(key)) continue;
      update[`sections.${lyricsData.sectionIdx}.lines.${lyricsData.lineIdx}.words.${lyricsData.wordIndex}.${key}`] = value;
    }
    if (Object.keys(update).length === 0) return Lyrics.findOne({ publicId }, null, { session }) as Promise<LyricsDoc | null>;
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    ) as Promise<LyricsDoc | null>;
  }

  const lyricsUpdate: Record<string, unknown> = {};
  if (lyricsData.editorMode !== undefined) lyricsUpdate.editorMode = lyricsData.editorMode;
  if (lyricsData.language !== undefined) lyricsUpdate.language = lyricsData.language;
  if (lyricsData.sections !== undefined) lyricsUpdate.sections = lyricsData.sections;

  if (Object.keys(lyricsUpdate).length > 0) {
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: lyricsUpdate, $unset: { lines: 1 }, $inc: { version: 1 } },
      { upsert: true, new: true, session }
    ) as Promise<LyricsDoc | null>;
  }

  return Lyrics.findOne({ publicId }, null, { session }) as Promise<LyricsDoc | null>;
}

// Lazy migration: if doc has legacy flat lines[] but no sections[], convert and save.
// Returns the sections array ready to include in the API response.
async function resolveSections(doc: LyricsDoc | null): Promise<SectionEntry[]> {
  if (!doc) return [];
  const sections = doc.sections as SectionEntry[] | undefined;
  if (sections && sections.length > 0) return sections;
  const legacyLines = (doc as unknown as { lines?: LineEntry[] }).lines;
  if (!legacyLines?.length) return [];
  const migrated = migrateLinesToSections(legacyLines);
  // Fire-and-forget migration write — don't block the response
  Lyrics.updateOne(
    { publicId: (doc as unknown as { publicId: string }).publicId },
    { $set: { sections: migrated }, $unset: { lines: 1 } }
  ).catch(() => {});
  return migrated;
}

export async function deleteProject(
  publicId: string,
  userId: string
): Promise<ServiceResult> {
  const project = await Project.findOne({ publicId });
  if (!project) return { error: 'Project not found', status: 404 } as ServiceResult;

  if (!project.isOwnedBy(userId)) {
    return { error: 'Not authorized to delete this project', status: 403 } as ServiceResult;
  }

  await withTransaction(async (session) => {
    await Project.deleteOne({ publicId }, { session });
    await Lyrics.deleteOne({ publicId }, { session });
  }, { operation: 'deleteProject', publicId, userId });

  logUserAction({
    userId,
    action: 'PROJECT_DELETE',
    entityType: 'Project',
    entityId: project._id.toString(),
    ip: 'unknown',
    deviceId: 'unknown',
    metadata: { publicId },
  });

  return {};
}
