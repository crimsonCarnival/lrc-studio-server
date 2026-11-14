// Hand-written layer over the introspected schemas: domain groups, entity descriptions,
// and the relationships Mongoose can't see (string-key joins, polymorphic targets).

// Group order = column placement: [column, order within column].
export type Group = { id: string; label: string; color: string; col: number }
export type RawEntity = { name: string; collection: string; group: string; file: string; desc: string; legacy?: boolean; fields: { p: string; t: string; f?: string[] }[] }
export type ExtraEdge = { from: string; to: string; kind: 'soft' | 'poly' | 'noref'; note?: string; many?: boolean }

export const GROUPS: Group[] = [
  { id: 'auth', label: 'Auth & sessions', color: 'subtle', col: 0 },
  { id: 'moderation', label: 'Moderation & admin', color: 'love', col: 0 },
  { id: 'system', label: 'System & infra', color: 'muted', col: 3 },
  { id: 'accounts', label: 'Accounts', color: 'iris', col: 1 },
  { id: 'engagement', label: 'Activity, notifications & progression', color: 'gold', col: 1 },
  { id: 'projects', label: 'Projects & content', color: 'pine', col: 2 },
  { id: 'social', label: 'Social graph', color: 'foam', col: 2 },
  { id: 'wall', label: 'Profile wall', color: 'rose', col: 3 },
]

// name -> [group, description]
export const ENTITIES: Record<string, [group: string, description: string]> = {
  User: ['accounts', 'The account. Identity (accountName, email, Google link), Argon2id password hash, ban/appeal and shadow-ban state, permission array (role is descriptive only), denormalised counters (social, stats, streak, progression) and granted badges. Nearly every other collection points here.'],
  AccountNameHistory: ['accounts', 'Audit trail of @accountName changes: one row per rename, from → to. Backs the rename cooldown and old-handle lookups.'],
  EmailHistory: ['accounts', 'Audit trail of email address changes: one row per change, from → to.'],
  UserPreferences: ['accounts', 'Per-user privacy and social preferences: online/country visibility, mini-profile badges, wall moderation rules, and per-type notification opt-outs. One document per user.'],
  Settings: ['accounts', 'Per-user editor settings synced from the client SettingsProvider: playback, editor, export, interface, shortcuts, advanced and Auto Stamp. Deep-merged with localStorage on the client and patched per path.'],

  Session: ['auth', 'One refresh-token session per signed-in device. Stores only token hashes; rotation keeps the previous hash for a short replay window, and familyId groups rotations so a replayed token revokes the whole family. TTL on expiresAt.'],
  Passkey: ['auth', 'A WebAuthn credential registered by a user: credential id, public key, signature counter and transports, plus the device label shown in the passkey list.'],
  UserDevice: ['auth', 'Device ids (X-Device-Id) seen per user, for device tracking and device bans. Expires after a year unseen.'],
  OneTimeToken: ['auth', 'Google OAuth one-time token: minted by the OAuth callback, consumed once by POST /auth/exchange-ott. Moved from an in-process Map to Mongo so mint and consume can land on different instances. TTL on expiresAt.'],
  PasswordReset: ['auth', 'Password-reset tokens (hashed), keyed by email rather than user id. Single-use, TTL on expiresAt; a compound index backs the request rate limit.'],
  EmailVerification: ['auth', 'Email verification and email-change confirmation tokens (hashed). Single-use, TTL on expiresAt.'],

  Project: ['projects', 'The top-level work: a song (or subtitle) project owned by a user. Points at its Upload (media) and Lyrics document, carries song metadata, editor state, visibility flags (public, listed, ownerActive), fork lineage, collaborators and social counters. Addressed externally by publicId (nanoid).'],
  Lyrics: ['projects', 'The lyrics document for one project, stored apart from Project. Nested sections → lines → words; the client flattens it to EditorLine[] and back (flatToSections / sectionsToFlat). editorMode is lrc, srt or words.'],
  Upload: ['projects', 'A media attachment: a Cloudinary audio file or a YouTube URL (source enum). publicId here is the Cloudinary asset id, not a project id.'],
  Artist: ['projects', 'An artist name a user has credited on their songs. Scoped per user on purpose: it feeds that user\'s own autocomplete and is never shared across accounts.'],
  CollabSession: ['projects', 'A live collaboration session on one project: invites (hashed tokens), members with roles and cursor colours, kicked subjects. One open session per project (endedAt null).'],
  CollabDoc: ['projects', 'Persisted Yjs CRDT state for a collaboratively edited project, named project:<publicId>. lyricsVersion tracks which Lyrics revision the state was built from.'],

  ProjectStar: ['social', 'One user starring one project. Project.starCount is the denormalised count.'],
  ProjectFork: ['social', 'Fork lineage ledger: which project was forked into which, by whom. Project.forkCount is the denormalised count.'],
  ProjectView: ['social', 'Dedup ledger for view counts: one row per (viewer, project, UTC day), inserted before Project.viewCount is incremented. viewerKey is the user id hex or d:<deviceId>. 2-day TTL.'],
  ProfileShare: ['social', 'A user putting someone else\'s public project on their own profile, with a note. Replaced the old boosts collection.'],
  Reaction: ['social', 'An emoji reaction by one user on one project. targetType only allows "project" today.'],
  ExploreEvent: ['social', 'Anonymous Explore feed telemetry: impressions, clicks and summed feed position per (project, UTC day). Holds no user, device or IP. Used to tune the trending weights. 90-day TTL.'],
  Playlist: ['social', 'A user-curated list of projects, public or private, with a sort mode and trending score. Mirrors Project\'s listed / ownerActive visibility flags.'],
  SavedPlaylist: ['social', 'A user saving someone\'s playlist to their library. Playlist.savedCount is the denormalised count.'],
  Follow: ['social', 'Follower → following edge between users, with what the follower wants to hear about (notify). User.social counters are denormalised from this.'],
  Block: ['social', 'One user blocking another. Distinct from admin IP/device network bans.'],

  WallComment: ['wall', 'A comment on a user\'s profile wall. Threads up to depth 2; status visible / pending (held for approval) / hidden; edit history in revisions; soft-deleted placeholders keep reply order.'],
  WallCommentLike: ['wall', 'One user liking one wall comment. The like count is derived from these rows, never stored.'],
  WallCommentReaction: ['wall', 'One user\'s emoji reaction on one wall comment; a user may add several emoji.'],
  WallCommentReport: ['wall', 'Legacy per-comment report, superseded by the generic Report collection (migrate-wall-reports.ts). Keeps the author so their record survives the comment\'s removal.'],
  WallSubscription: ['wall', 'A user subscribing to new comments on someone\'s wall.'],
  WallThreadMute: ['wall', 'A user muting replies in one thread, keyed by its top-level comment.'],
  WallRestriction: ['wall', 'A moderator barring a user from commenting on any wall until a date (null: until lifted).'],

  Activity: ['engagement', 'Public social-feed events (published, starred, forked, shared, playlist created, followed). Denormalises project title and cover so the feed needs no join. 365-day TTL.'],
  HeatmapDay: ['engagement', 'Private per-user, per-UTC-day counters for the activity heatmap: distinct projects created and distinct projects edited. Never read by the feed. 400-day TTL.'],
  HeatmapProjectEdit: ['engagement', 'Dedup ledger for HeatmapDay.editedProjects: one row per (user, project, day), inserted before the counter increments so concurrent autosaves count once. 2-day TTL.'],
  Notification: ['engagement', 'An in-app notification for one user (34 types). Repeat events on the same thing aggregate via dedupeKey into one row with an actors list and actorCount. Delivered live over Socket.IO.'],
  BadgeDefinition: ['engagement', 'A badge users can earn: bilingual label, rarity, colour, grant condition (type + value), XP reward. Built-ins are seeded; others are staff-created. Users hold badges by this definition\'s id string.'],
  AddictionLevel: ['engagement', 'Admin-defined title tiers ("addiction levels") unlocked by stats thresholds: synced lines, minutes, stars received, and so on. Any requirement left 0 is not required.'],
  XPEvent: ['engagement', 'Append-only XP ledger: every grant, revoke, adjustment or recompute with its delta and the total after it. The userId has no Mongoose ref, but it is a User id.'],

  AdminLog: ['moderation', 'Audit log of staff actions (ban, role change, badge grant, ...), with actor, target and IP. Superadmin env grants are attributed to system:SUPERADMIN_EMAIL. 90-day TTL.'],
  BannedIp: ['moderation', 'An IP address blocked from the network, optionally tied to the user who triggered it. 2-year TTL since dynamic IPs rotate.'],
  BannedDevice: ['moderation', 'A device id blocked from the network. 2-year TTL.'],
  Report: ['moderation', 'One person\'s report of a wall comment, user, project or playlist. targetId is polymorphic (resolved by targetType) and survives the target\'s removal; subjectUserId keeps who is accountable.'],
  ReportMessage: ['moderation', 'A message in a report\'s conversation between reporter and moderators. Replies (parentId) answer a top-level message and do not nest further.'],
  StaffRequest: ['moderation', 'A staff proposal (block IP/device, adjust XP, badge or level CRUD) from staff without the permission, awaiting review by staff with it. Payload is whitelisted per type; approval re-checks the reviewer.'],
  RolePermissionsConfig: ['moderation', 'Singleton (_id "singleton") holding admin-edited overrides of the mod and admin role presets. user is always empty and superadmin always has everything, so neither is stored.'],
  UserActionLog: ['moderation', 'Per-user action audit log written by services (never controllers): action, entity type/id, metadata, IP and device.'],

  JobLog: ['system', 'Log of lyrics jobs (extract_lyrics: lyrics search/import through the provider chain; infer_end_times): query, provider, synced or not, line count, duration, outcome, and who asked.'],
  SeedMarker: ['system', 'Records that a code-defined default (an addiction level, ...) was seeded once, so deliberately deleted defaults are not resurrected. _id is <kind>:<key>.'],
}

// Collections that exist in Mongo but have no Mongoose model.
export const RAW: RawEntity[] = [
  { name: 'socket_io_adapter_events', collection: 'socket_io_adapter_events', group: 'system', file: 'src/plugins/socket.ts', desc: 'Event log used by the Socket.IO MongoDB adapter to fan events out across server instances. Created at startup with a TTL index on createdAt instead of a capped collection. No Mongoose schema.', fields: [{ p: '_id', t: 'ObjectId', f: ['PK'] }, { p: 'createdAt', t: 'Date', f: ['TTL'] }, { p: '…', t: 'adapter payload' }] },
  { name: 'boosts', collection: 'boosts', group: 'system', file: 'src/modules/projects/boost-to-profile-share.migration.ts', desc: 'Legacy collection from the old Boost feature. Read only by the migration that converts rows into ProfileShare; slated to be dropped together with the deprecated boost GraphQL aliases.', legacy: true, fields: [{ p: '…', t: 'legacy rows' }] },
]

// Relationships Mongoose can't see. from: 'Model.path' (dotted, [] steps elided), to: 'Model.path'.
// kind: soft = joined by a string key with no ref; poly = target collection depends on another field;
//       noref = ObjectId that lacks a `ref` option.
export const EXTRA_EDGES: ExtraEdge[] = [
  { from: 'Lyrics.publicId', to: 'Project.publicId', kind: 'soft', note: 'Lyrics are also reachable as Project.lyricsId.' },
  { from: 'Project.forkedFrom.publicId', to: 'Project.publicId', kind: 'soft', note: 'Source project of a fork.' },
  { from: 'ProjectStar.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'ProjectFork.sourcepublicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'ProjectFork.forkedpublicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'ProjectView.projectId', to: 'Project.publicId', kind: 'soft', note: 'Named projectId but holds the publicId.' },
  { from: 'ProjectView.viewerKey', to: 'User._id', kind: 'soft', note: 'User id hex for signed-in viewers; d:<deviceId> for anonymous ones.' },
  { from: 'ProfileShare.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'ExploreEvent.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'Reaction.targetId', to: 'Project.publicId', kind: 'soft', note: 'targetType is always "project" today.' },
  { from: 'Activity.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'HeatmapProjectEdit.projectId', to: 'Project.publicId', kind: 'soft', note: 'Named projectId but holds the publicId.' },
  { from: 'Notification.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'CollabSession.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'CollabDoc.name', to: 'Project.publicId', kind: 'soft', note: 'Document name is "project:" + publicId.' },
  { from: 'JobLog.publicId', to: 'Project.publicId', kind: 'soft' },
  { from: 'User.badges.id', to: 'BadgeDefinition.id', kind: 'soft' },
  { from: 'User.showcasedBadges', to: 'BadgeDefinition.id', kind: 'soft', many: true },
  { from: 'UserPreferences.miniProfileBadgeIds', to: 'BadgeDefinition.id', kind: 'soft', many: true },
  { from: 'PasswordReset.email', to: 'User.email', kind: 'soft', note: 'Reset tokens are keyed by email, not user id.' },
  { from: 'SeedMarker._id', to: 'AddictionLevel.id', kind: 'soft', note: '_id is "addiction_level:<id>" for level seeds.' },
  { from: 'XPEvent.userId', to: 'User._id', kind: 'noref', note: 'ObjectId without a ref option.' },
  { from: 'Report.targetId', to: 'WallComment._id', kind: 'poly', note: 'When targetType = wall_comment.' },
  { from: 'Report.targetId', to: 'User._id', kind: 'poly', note: 'When targetType = user.' },
  { from: 'Report.targetId', to: 'Project._id', kind: 'poly', note: 'When targetType = project.' },
  { from: 'Report.targetId', to: 'Playlist._id', kind: 'poly', note: 'When targetType = playlist.' },
  { from: 'boosts.…', to: 'ProfileShare._id', kind: 'soft', note: 'Migrated into profile_shares.' },
]

// Notes appended to specific field tooltips.
export const FIELD_NOTES: Record<string, string> = {
  'Upload.publicId': 'Cloudinary asset public id. Unrelated to Project.publicId.',
  'Playlist.publicIds': 'Despite the name, holds Project ObjectIds (_id), not publicIds.',
  'Project.lyricsId': 'The Lyrics document, also joinable by Lyrics.publicId.',
  'User.permissions': 'Source of truth for authorization. role never grants access on its own.',
  'User.role': 'Descriptive only; permissions[] grants access.',
  'User.passwordHash': 'Argon2id hash. Not select:false, so queries must project it out themselves.',
  'Lyrics.lines': 'Legacy flat lines array (select:false), converted into sections on read; sections is the live shape.',
}

// Embedded groups shown expanded even though they are big.
export const EXPAND_BY_DEFAULT: string[] = ['Lyrics.sections', 'Lyrics.sections.lines']
