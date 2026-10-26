import type { ServiceResult, ProjectPublic, ProjectListItem, UploadInfo, SectionEntry, LineEntry } from '../../types/index.js';
import { migrateLinesToSections } from '../lyrics/lyrics.model.js';
import { notifyFollowedProject } from '../notifications/notifications.events.js';
import { linkArtistIds, type StoredCredit } from '../artists/artist.service.js';
import { projectPath } from '../../utils/project-slug.js';
import { sanitizeUrl } from '../../utils/sanitize.js';
import mongoose from 'mongoose';
import Project from './project.model.js';
import ProjectFork from './project-fork.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import User from '../users/user.model.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import { verifyRecaptcha } from '../auth/auth.service.js';
import { logUserAction } from '../user-logs/logs.service.js';
import { withTransaction } from '../../db/transaction.js';
import { writeActivity, recordHeatmapEvent } from '../activity/activity.service.js';
import { isDeepStrictEqual } from 'node:util';
import { recomputeSyncStats, scheduleSyncStatsRefresh, triggerBadgeCheck, updateStreak } from '../badges/badge.service.js';
import { recomputeLeaderboardRanking } from '../../jobs/leaderboard-ranking.job.js';
import { visibilityForNewContent } from '../users/owner-visibility.service.js';
import {
  PROJECT_IDENTITY_REQUIRED, cleanTitle, cleanIdentityMetadata, hasProjectIdentity, slugFor, resolveMetadataArtists,
} from './project-identity.js';
// Shape of a lean project from listProjects query (populated uploadId is an object)
interface LeanProjectListItem {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  title?: string;
  slug?: string;
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
  viewCount?: number;
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
  /** Attribution for what triggered creation (e.g. `uploads_library`), carried from the `ref` URL param. */
  createdFrom?: string;
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
    // Positional multi-line patch: several lines changed, line count and
    // section markers unchanged. Checked before the single-line shape above
    // since that shape's fields (sectionIdx/lineIdx/line) are absent here.
    lines?: Array<{ sectionIdx: number; lineIdx: number; line: Record<string, unknown> }>;
  };
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  readOnly?: boolean;
  public?: boolean;
  coverImage?: string;
  version?: number;
  /** Caller intent only ('manual' = explicit user save). Absent = autosave. Never proof of change. */
  saveKind?: SaveKind;
}

export type SaveKind = 'manual' | 'auto';

// Every client flow that ends in a create (see executeRecaptchaSafe call sites).
const PROJECT_CREATE_RECAPTCHA_ACTIONS = ['create_project', 'autosave_create', 'restore_project', 'share_project'] as const;

export async function createProject(
  rawData: unknown,
  userId: string | null | undefined,
  ip: string
): Promise<{ publicId: string; url: string } | ServiceResult> {
  const data = rawData as CreateProjectData;
  const {
    title, uploadId, lyrics, state, metadata, readOnly, public: isPublic,
    coverImage, recaptchaToken, ytUrl, uploadUrl, uploadPublicId, fileName, duration, createdFrom,
  } = data;

  if (!userId) {
    return { error: 'Authentication required', status: 401 } as ServiceResult;
  }

  // Every create path (GraphQL, autosave auto-create, guest claim, import) lands
  // here, so this is the one place a nameless project is refused.
  const cleanedTitle = cleanTitle(title);
  const resolvedMetadata = resolveMetadataArtists(cleanIdentityMetadata(metadata), null);
  if ('failure' in resolvedMetadata) return { ...resolvedMetadata.failure } as ServiceResult;
  const cleanedMetadata = resolvedMetadata.metadata;
  if (!hasProjectIdentity(cleanedTitle, cleanedMetadata)) {
    return { ...PROJECT_IDENTITY_REQUIRED } as ServiceResult;
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

  if (!(await verifyRecaptcha(recaptchaToken, ip, PROJECT_CREATE_RECAPTCHA_ACTIONS))) {
    return { error: 'recaptcha_failed', status: 403, code: 'recaptcha_failed' } as ServiceResult;
  }

  if (uploadId) {
    const ownedUpload = await Upload.findOne({ _id: uploadId, userId });
    if (!ownedUpload) {
      return { error: 'Not authorized to use this upload', status: 403 } as ServiceResult;
    }
  }

  await linkMetadataArtists(userId, cleanedMetadata);

  const result = await withTransaction(async (session) => {
    // Resolve uploadId: use provided ID, or create inline from raw media URL
    let resolvedUploadId: mongoose.Types.ObjectId | null = uploadId
      ? new mongoose.Types.ObjectId(uploadId)
      : null;

    if (!resolvedUploadId && ytUrl) {
      const [upload] = await Upload.create([{
        userId: userId || null,
        source: 'youtube',
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

    let finalIsPublic: boolean;
    if (isPublic !== undefined) {
      finalIsPublic = isPublic;
    } else if (userId) {
      const prefs = await getPreferences(userId);
      // Ensure backwards compatibility by defaulting to public if the preference is somehow missing
      finalIsPublic = prefs?.defaultProjectPrivacy !== 'private';
    } else {
      finalIsPublic = false; // Guests default to private
    }

    // New content inherits the owner's current visibility, so a shadow-banned
    // user's new project is unlisted from the moment it exists rather than
    // until the next sync. Guests (no userId) are treated as visible.
    const ownerVisibility = await visibilityForNewContent(userId);

    const [project] = await Project.create([{
      ...ownerVisibility,
      userId: userId || null,
      title: cleanedTitle,
      uploadId: resolvedUploadId,
      state: state || {},
      metadata: cleanedMetadata,
      coverImage: (coverImage ? sanitizeUrl(coverImage) : '') as string,
      readOnly: readOnly ?? true,
      public: finalIsPublic,
      createdFrom: createdFrom ? createdFrom.slice(0, 64) : null,
      contentUpdatedAt: new Date(),
    }], { session });

    const incomingSections: SectionEntry[] = lyrics?.sections
      ? (lyrics.sections as SectionEntry[])
      : migrateLinesToSections((lyrics?.lines as LineEntry[]) || []);

    const [lyricsDoc] = await Lyrics.create([{
      publicId: project.publicId,
      editorMode: (lyrics?.editorMode || 'lrc') as 'lrc' | 'srt' | 'words',
      sections: incomingSections,
    }], { session });

    project.lyricsId = lyricsDoc._id;
    await project.save({ session });

    const owner = await User.findById(userId).select('accountName').session(session).lean<{ accountName?: string }>();
    return { publicId: project.publicId, url: projectPath(project, owner?.accountName) };
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
    // Every create path (REST POST, GraphQL createProject, autosave auto-create,
    // guest→account migration) funnels through here; forks use cloneProject and
    // are already counted via their project_forked activity.
    recordHeatmapEvent(userId, 'project_created', result.publicId).catch(() => {});
    // Keep the denormalized leaderboard counter live. Fire-and-forget like the
    // side effects above: the hourly leaderboard-ranking job rewrites this field
    // from the authoritative Project aggregation, so a lost $inc self-heals.
    // Forks do not come through here — cloneProject increments its own owner.
    User.updateOne({ _id: userId }, { $inc: { projectCount: 1 } }).catch(() => {});
  }

  return result;
}

export async function listProjects(userId: string): Promise<ProjectListItem[]> {
  const projects = await Project.find({ userId })
    .select('publicId title slug metadata coverImage uploadId readOnly public createdAt updatedAt forkedFrom forkCount starCount viewCount')
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
      slug: s.slug || slugFor(s.title, s.metadata),
      metadata: s.metadata || {},
      coverImage: s.coverImage || '',
      upload: uploadObj,
      editorMode: (lyrics?.editorMode || 'lrc') as 'lrc' | 'srt' | 'words',
      lineCount: lyrics?.lineCount ?? 0,
      syncedLineCount: lyrics?.syncedLineCount ?? 0,
      readOnly: s.readOnly,
      public: s.public,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      forkedFrom: s.forkedFrom?.publicId ? s.forkedFrom : null,
      forkCount: s.forkCount ?? 0,
      starCount: s.starCount ?? 0,
      viewCount: s.viewCount ?? 0,
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

  // A deactivated or banned owner's project is not readable by anyone but its
  // owner, even by direct link — otherwise a ban is bypassed by sharing the
  // link, which is the argument og.meta.service already makes for crawler
  // cards. `ownerActive`, not `ownerListed`: a shadow ban only removes content
  // from discovery, so a shadow-banned project must still open by link or the
  // shadow ban is detectable by its target.
  if (project.ownerActive === false && !project.isOwnedBy(requestingUserId ?? '')) return null;

  // Refresh stats for the owner on project load so settings→stats and leaderboard stay current.
  // Throttled to once per 5 minutes to avoid expensive repeated aggregations.
  if (requestingUserId && project.isOwnedBy(requestingUserId)) {
    User.findById(requestingUserId).select('statsComputedAt').lean<{ statsComputedAt?: Date | null }>().then(u => {
      const stale = !u?.statsComputedAt || (Date.now() - u.statsComputedAt.getTime() > 5 * 60 * 1000);
      if (stale) recomputeSyncStats(requestingUserId).catch(() => undefined);
    }).catch(() => undefined);
  }

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

  if (uploadId !== undefined) {
    const ownedUpload = await Upload.findOne({ _id: uploadId, userId });
    if (!ownedUpload) {
      return { error: 'Not authorized to use this upload', status: 403 } as ServiceResult;
    }
  }

  const projectUpdate: Record<string, unknown> = {};
  if (title !== undefined) projectUpdate.title = title;
  if (uploadId !== undefined) projectUpdate.uploadId = uploadId;
  if (state !== undefined) projectUpdate.state = state;
  if (metadata !== undefined) projectUpdate.metadata = preserveSingers(metadata, project.metadata);
  if (readOnly !== undefined) projectUpdate.readOnly = readOnly;
  if (data.public !== undefined) projectUpdate.public = data.public;
  if (data.coverImage !== undefined) projectUpdate.coverImage = sanitizeUrl(data.coverImage);

  const identityError = applyProjectIdentity(project, projectUpdate);
  if (identityError) return identityError as ServiceResult;
  await linkMetadataArtists(userId, projectUpdate.metadata);

  // Stamped in the same write, so no extra round trip. Lyrics in the payload
  // count as an edit without diffing them: the client only sends them when its
  // own diff found a change.
  if (lyrics !== undefined || updateTouchesContent(project, projectUpdate)) {
    projectUpdate.contentUpdatedAt = new Date();
  }

  const lyricsPromise = (() => {
    if (lyrics === undefined) return Lyrics.findOne({ publicId });
    const lyricsUpdate: Record<string, unknown> = {};
    if (lyrics.editorMode !== undefined) lyricsUpdate.editorMode = lyrics.editorMode;
    if (lyrics.language !== undefined) lyricsUpdate.language = lyrics.language;
    if (lyrics.sections !== undefined) lyricsUpdate.sections = lyrics.sections;
    if (lyricsUpdate.sections) assertValidSectionsTiming(lyricsUpdate.sections as unknown[]);
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: lyricsUpdate, $unset: { lines: 1 }, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
  })();

  const [updatedProject, updatedLyrics] = await Promise.all([
    Project.findOneAndUpdate(
      { publicId },
      { $set: projectUpdate, $inc: { version: 1 } },
      { returnDocument: 'after' }
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

  if (lyrics !== undefined && userId) {
    Promise.all([
      recomputeSyncStats(userId),
      updateStreak(userId),
    ]).then(([_stats]) =>
      Promise.all([
        triggerBadgeCheck(userId, 'sync_update'),
        recomputeLeaderboardRanking(),
      ])
    ).catch(() => {});
  }

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

  if (data.uploadId !== undefined) {
    const ownedUpload = await Upload.findOne({ _id: data.uploadId, userId });
    if (!ownedUpload) {
      return { error: 'Not authorized to use this upload', status: 403 } as ServiceResult;
    }
  }

  // Detect publish transition (false → true) before the transaction overwrites the doc
  const wasPublic = !!project.public;
  const isPublishing = data.public === true && !wasPublic;

  const projectUpdate: Record<string, unknown> = {};
  const allowed = ['title', 'uploadId', 'state', 'metadata', 'readOnly', 'public', 'coverImage'] as const;
  for (const key of allowed) {
    if (data[key] !== undefined) projectUpdate[key] = data[key];
  }
  if (data.metadata !== undefined) projectUpdate.metadata = preserveSingers(data.metadata, project.metadata);

  const identityError = applyProjectIdentity(project, projectUpdate);
  if (identityError) return identityError as ServiceResult;
  await linkMetadataArtists(userId, projectUpdate.metadata);

  // Same stamp as updateProject, set before `hasProjectUpdate` so a lyrics-only
  // patch still writes the project doc to record when its content last changed.
  if (data.lyrics !== undefined || updateTouchesContent(project, projectUpdate)) {
    projectUpdate.contentUpdatedAt = new Date();
  }

  const hasProjectUpdate = Object.keys(projectUpdate).length > 0;
  // No client sends `version` today — opt-in, same as before — but when one
  // does, the check now lives in the update's own filter instead of a
  // separate read-then-compare ahead of the transaction. The gap between
  // that read and the write below was a real race: two concurrent patches
  // could both pass the check against the same stale value and both write,
  // the second silently clobbering the first. Forcing a write even when
  // nothing else changed is what lets a lyrics-only patch still be gated by
  // the project's version — it only ever adds the version-matching
  // precondition and the version bump the code already did unconditionally.
  const needsProjectWrite = hasProjectUpdate || data.version !== undefined;
  // Any save by an authenticated user is a heatmap candidate now — manual and
  // auto both count, deduped to one contribution per project per day (see
  // recordHeatmapEvent). `saveKind` is no longer part of this gate; it's kept
  // on the wire for other analytics. Whether the save actually changed
  // anything is decided below from persisted state, never from the client.
  const trackForHeatmap = !!userId;
  let lyricsBefore: LyricsContent | null = null;
  let lyricsAfter: LyricsContent | null = null;

  const result = await withTransaction(async (session) => {
    let updatedProject = project;
    if (needsProjectWrite) {
      const filter: Record<string, unknown> = { publicId };
      if (data.version !== undefined) filter.version = data.version;
      const found = await Project.findOneAndUpdate(
        filter,
        { $set: projectUpdate, $inc: { version: 1 } },
        { returnDocument: 'after', session }
      ).populate('uploadId', 'source fileName youtubeUrl uploadUrl duration title artist');
      // No match means either the project vanished, or (when a version was
      // given) it moved since this request read it — a real conflict, not
      // something to fall back to a stale `project` for. Nothing was
      // written, so there is nothing to roll back; the transaction still
      // commits empty and patchProject reports it below.
      // No match means either a concurrent delete (no version was given —
      // genuinely gone) or the version moved since this request read it (a
      // version was given and didn't match — a real conflict). Nothing was
      // written either way, so there is nothing to roll back; the
      // transaction still commits empty and patchProject reports it below.
      if (!found) {
        return data.version !== undefined
          ? { ok: false as const, reason: 'version_conflict' as const }
          : { ok: false as const, reason: 'not_found' as const };
      }
      updatedProject = found;
    }

    let updatedLyrics;
    if (data.lyrics !== undefined) {
      if (trackForHeatmap) lyricsBefore = await readLyricsContent(publicId, session);
      updatedLyrics = await patchLyricsWithSession(publicId, data.lyrics, session);
      if (trackForHeatmap) lyricsAfter = await readLyricsContent(publicId, session);
    } else {
      updatedLyrics = await Lyrics.findOne({ publicId }, null, { session });
    }

    return { ok: true as const, updatedProject, updatedLyrics };
  }, { operation: 'patchProject', publicId, userId: userId ?? null });

  if (!result.ok) {
    return result.reason === 'version_conflict'
      ? ({ error: 'Version conflict — reload and retry', status: 409 } as ServiceResult)
      : ({ error: 'Project not found', status: 404 } as ServiceResult);
  }
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
    // targetPath spares the web client from rebuilding the owner-scoped URL.
    // Best-effort: an owner with no accountName leaves it unset rather than
    // throwing out of projectPath() and losing the activity row entirely.
    User.findById(userId).select('accountName avatarUrl').lean<{ accountName?: string; avatarUrl?: string | null }>()
      .then((owner) => {
        if (owner?.accountName) {
          notifyFollowedProject({
            author: { userId, accountName: owner.accountName, avatarUrl: owner.avatarUrl ?? null },
            publicId,
            projectTitle: updatedProject?.title || '',
            kind: 'published',
          }).catch(() => {});
        }
        return writeActivity({
          actorId:      userId,
          type:         'project_published',
          publicId,
          projectTitle: updatedProject?.title || '',
          coverImage:   updatedProject?.coverImage || '',
          targetPath:   owner?.accountName && updatedProject
            ? projectPath(updatedProject, owner.accountName)
            : undefined,
        });
      })
      .catch(() => {});
  }

  if (data.lyrics !== undefined && userId) {
    updateStreak(userId).catch(() => {});
    scheduleSyncStatsRefresh(userId);
  }

  if (trackForHeatmap && userId && (
    projectContentChanged(project, updatedProject) || !isDeepStrictEqual(lyricsBefore, lyricsAfter)
  )) {
    recordHeatmapEvent(userId, 'project_edited', publicId).catch(() => {});
    // Followers who asked to hear about edits. Publishing already told the others.
    if (!isPublishing && updatedProject?.public) {
      User.findById(userId).select('accountName avatarUrl').lean<{ accountName?: string; avatarUrl?: string | null }>()
        .then((owner) => {
          if (!owner?.accountName) return;
          return notifyFollowedProject({
            author: { userId, accountName: owner.accountName, avatarUrl: owner.avatarUrl ?? null },
            publicId,
            projectTitle: updatedProject.title || '',
            kind: 'updated',
          });
        })
        .catch(() => {});
    }
  }

  return { project: pub as unknown as ProjectPublic };
}

const plainMetadata = (m: unknown): Record<string, unknown> | null =>
  (m as { toObject?: () => Record<string, unknown> } | null | undefined)?.toObject?.() ?? (m as Record<string, unknown> | null) ?? null;

/** Gives newly named credits their artist-record ids (owner-scoped). No-op without credits. */
async function linkMetadataArtists(userId: string | null | undefined, metadata: unknown): Promise<void> {
  const credits = (metadata as { artists?: StoredCredit[] } | undefined)?.artists;
  if (userId && Array.isArray(credits) && credits.length > 0) await linkArtistIds(userId, credits);
}

/**
 * Normalises title/metadata in a pending update and keeps the derived slug in
 * step with them, in the same write. Only refuses an update that would strip a
 * project of the last of its title / song name / artist, so an unrelated edit
 * to a legacy row that never had one is not blocked.
 */
export function applyProjectIdentity(
  existing: { title?: string; metadata?: unknown },
  update: Record<string, unknown>,
): ServiceResult | null {
  if (!('title' in update) && !('metadata' in update)) return null;
  if ('title' in update) update.title = cleanTitle(update.title);
  if ('metadata' in update) {
    const resolved = resolveMetadataArtists(cleanIdentityMetadata(update.metadata as Record<string, unknown>), plainMetadata(existing.metadata));
    if ('failure' in resolved) return { ...resolved.failure } as ServiceResult;
    update.metadata = resolved.metadata;
  }

  const title = 'title' in update ? update.title : existing.title;
  const metadata = ('metadata' in update ? update.metadata : existing.metadata) as Record<string, unknown> | undefined;
  if (hasProjectIdentity(existing.title, existing.metadata as Record<string, unknown> | undefined)
      && !hasProjectIdentity(title, metadata)) {
    return { ...PROJECT_IDENTITY_REQUIRED } as ServiceResult;
  }
  update.slug = slugFor(title, metadata);
  return null;
}

// "Actual changes" for the heatmap = authored content. Excluded on purpose:
// `state` (playback position / active line / saveTime move on every save),
// and `public` / `readOnly` (visibility toggles; publishing has its own activity).
const CONTENT_PROJECT_FIELDS = ['title', 'metadata', 'coverImage'] as const;

/**
 * True when a pending `$set` would change something a reader would call an edit.
 * Deliberately blind to `state` (playback position, active line, sync mode),
 * visibility flags and counters: those move on autosaves and background writes,
 * which is exactly why `updatedAt` cannot be shown as the "edited ..." time.
 * Compared against the stored values, so re-sending an unchanged field is not
 * an edit either.
 */
function updateTouchesContent(existing: ProjectDocLike, update: Record<string, unknown>): boolean {
  const before = existing.toObject({ depopulate: true });
  if ('uploadId' in update && String(update.uploadId ?? '') !== String(before.uploadId ?? '')) return true;
  return CONTENT_PROJECT_FIELDS.some(
    (k) => k in update && !isDeepStrictEqual(update[k] ?? null, before[k] ?? null)
  );
}

type ProjectDocLike = { toObject(opts?: { depopulate?: boolean }): Record<string, unknown> };

function projectContentChanged(before: ProjectDocLike, after: ProjectDocLike): boolean {
  if (before === after) return false;
  const a = before.toObject({ depopulate: true });
  const b = after.toObject({ depopulate: true });
  if (String(a.uploadId ?? '') !== String(b.uploadId ?? '')) return true;
  return CONTENT_PROJECT_FIELDS.some((k) => !isDeepStrictEqual(a[k] ?? null, b[k] ?? null));
}

type LyricsContent = { editorMode?: string; language?: string | null; sections?: unknown[] };

// Lean reads on both sides so defaults/casting can't make an unchanged doc look different.
function readLyricsContent(publicId: string, session: mongoose.ClientSession): Promise<LyricsContent | null> {
  return Lyrics.findOne({ publicId }, 'editorMode language sections -_id', { session }).lean<LyricsContent>().exec();
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

// findOneAndUpdate never runs the Lyrics model's document-level pre('validate') hook
// (Mongoose only runs SchemaType path validators for updates, not document middleware),
// so cross-field timing checks must be re-applied here before every $set that can touch
// timestamp/endTime.
function assertValidLineTiming(line: { timestamp?: unknown; endTime?: unknown }, context: string): void {
  const { timestamp, endTime } = line;
  if (typeof timestamp === 'number' && typeof endTime === 'number' && endTime <= timestamp) {
    throw Object.assign(new Error(`${context}: endTime must be greater than timestamp`), { statusCode: 422 });
  }
}

// Metadata is replaced wholesale by $set. Edit surfaces that don't know about
// `singers` / `singerColors` (older clients, library/profile edit modals) send
// metadata without them, which would silently wipe them — keep the stored values
// unless the request sends the key.
const PRESERVED_METADATA_ARRAYS = ['singers', 'singerColors'] as const;

function preserveSingers(metadata: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return metadata;
  let result = metadata;
  for (const key of PRESERVED_METADATA_ARRAYS) {
    if (key in metadata) continue;
    const prev = (existing as Record<string, unknown> | null | undefined)?.[key];
    if (Array.isArray(prev) && prev.length > 0) result = { ...result, [key]: [...prev] };
  }
  return result;
}

function assertValidSectionsTiming(sections: unknown[]): void {
  for (const section of sections ?? []) {
    const lines = (section as { lines?: unknown[] })?.lines ?? [];
    lines.forEach((line, i) => assertValidLineTiming(line as { timestamp?: unknown; endTime?: unknown }, `Section line ${i}`));
  }
}

async function patchLyricsWithSession(
  publicId: string,
  lyricsData: NonNullable<UpdateProjectData['lyrics']>,
  session: mongoose.ClientSession
): Promise<LyricsDoc | null> {
  // Positional multi-line patch: several lines changed in one save (the
  // common case during active syncing — the single-line shape below only
  // fires when exactly one line differs), line count and section markers
  // both unchanged. One findOneAndUpdate with one dotted $set path per
  // changed line, same mechanism as the single-line branch just repeated.
  if (Array.isArray(lyricsData.lines)) {
    if (lyricsData.lines.length === 0 || lyricsData.lines.length > MAX_LINE_INDEX) {
      throw Object.assign(new Error('Invalid lines patch size'), { status: 400 });
    }
    const update: Record<string, unknown> = {};
    for (const entry of lyricsData.lines) {
      if (!isValidIndex(entry?.sectionIdx, MAX_SECTION_INDEX) || !isValidIndex(entry?.lineIdx, MAX_LINE_INDEX) || !entry?.line) {
        throw Object.assign(new Error('Invalid sectionIdx/lineIdx in lines patch'), { status: 400 });
      }
      assertValidLineTiming(entry.line, `Section ${entry.sectionIdx} line ${entry.lineIdx}`);
      for (const [key, value] of Object.entries(entry.line)) {
        if (!LINE_FIELDS.has(key)) continue;
        update[`sections.${entry.sectionIdx}.lines.${entry.lineIdx}.${key}`] = value;
      }
    }
    if (Object.keys(update).length === 0) return Lyrics.findOne({ publicId }, null, { session }) as Promise<LyricsDoc | null>;
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after', session }
    ) as Promise<LyricsDoc | null>;
  }

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
    assertValidLineTiming(lyricsData.line, `Section ${lyricsData.sectionIdx} line ${lyricsData.lineIdx}`);
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: update, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after', session }
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
      { upsert: true, returnDocument: 'after', session }
    ) as Promise<LyricsDoc | null>;
  }

  const lyricsUpdate: Record<string, unknown> = {};
  if (lyricsData.editorMode !== undefined) lyricsUpdate.editorMode = lyricsData.editorMode;
  if (lyricsData.language !== undefined) lyricsUpdate.language = lyricsData.language;
  if (lyricsData.sections !== undefined) lyricsUpdate.sections = lyricsData.sections;

  if (Object.keys(lyricsUpdate).length > 0) {
    if (lyricsUpdate.sections) assertValidSectionsTiming(lyricsUpdate.sections as unknown[]);
    return Lyrics.findOneAndUpdate(
      { publicId },
      { $set: lyricsUpdate, $unset: { lines: 1 }, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after', session }
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
    // 1. Fork bookkeeping: this project IS a fork of another project. Decrement the
    // source's forkCount (no-op if the source is already gone or already at 0) and
    // remove this fork's ProjectFork row.
    if (project.forkedFrom?.publicId) {
      await Project.updateOne(
        { publicId: project.forkedFrom.publicId, forkCount: { $gt: 0 } },
        { $inc: { forkCount: -1 } },
        { session, timestamps: false }
      );
      await ProjectFork.deleteOne({ forkedpublicId: publicId }, { session });
    }

    // 2. Source-with-forks cascade: this project IS a source with active forks pointing
    // at it. Mark those forks' forkedFrom.sourceDeleted — purely cosmetic, does not touch
    // public/readOnly/editability. The ProjectFork rows themselves are kept as historical
    // lineage records (only deleted when the FORK itself is deleted, in step 1 above).
    const childForks = await ProjectFork.find({ sourcepublicId: publicId }).session(session).lean();
    if (childForks.length > 0) {
      await Project.updateMany(
        { publicId: { $in: childForks.map((f) => f.forkedpublicId) } },
        { $set: { 'forkedFrom.sourceDeleted': true } },
        { session, timestamps: false }
      );
    }

    // 3. Existing behavior — unchanged. Project deletion never touches Upload documents
    // or Cloudinary assets: Uploads are a per-user shared media library (createMedia
    // upserts by (userId, source, uploadUrl), and multiple projects routinely point at
    // the same Upload without ever going through a fork). deleteMedia (uploads.service.ts)
    // already owns the full lifecycle of deleting an Upload, including its Cloudinary
    // asset and clearing $unset uploadId on every project that pointed at it.
    await Project.deleteOne({ publicId }, { session });
    await Lyrics.deleteOne({ publicId }, { session });

    // 4. Denormalized leaderboard counter. In the transaction so it cannot
    // decrement for a delete that rolls back. The `$gt: 0` guard keeps it from
    // going negative — `min: 0` on the schema is not enforced for $inc updates.
    // Reconciled hourly by the leaderboard-ranking job regardless.
    if (project.userId) {
      await User.updateOne(
        { _id: project.userId, projectCount: { $gt: 0 } },
        { $inc: { projectCount: -1 } },
        { session }
      );
    }
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
