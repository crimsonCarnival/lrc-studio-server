# LRC Studio — Server

The backend for [LRC Studio](https://www.lrcstudio.app), a lyrics synchronization platform. A Fastify 5 API serving REST, GraphQL and WebSockets over MongoDB, plus the AI transcription pipeline that powers Auto Stamp.

**[Live app](https://www.lrcstudio.app)** · [GitHub](https://github.com/crimsonCarnival/lrc-studio) · [Client README](https://github.com/crimsonCarnival/lrc-studio-client#readme)

> Translations: [Español (Spanish)](docs/translations/README.es.md)

## Table of Contents

- [Architecture](#architecture)
- [Module Map](#module-map)
- [API Reference](#api-reference)
  - [`/health`](#health)
  - [`/auth`](#auth)
  - [`/projects`](#projects)
  - [`/lyrics` and `/editor`](#lyrics-and-editor--parsing--editor-operations)
  - [`/lyrics` search & import](#lyrics--search--import)
  - [`/asr`](#asr--auto-stamp)
  - [`/uploads`](#uploads)
  - [`/settings`](#settings)
  - [`/notifications`](#notifications)
  - [Misc endpoints](#song-metadata-youtube-google-og)
  - [`/admin`](#admin)
  - [GraphQL](#graphql--post-graphql)
  - [Socket.IO](#socketio)
- [Key Subsystems](#key-subsystems)
  - [Authentication & Sessions](#authentication--sessions)
  - [Permissions](#permissions)
  - [Auto Stamp (ASR)](#auto-stamp-asr)
  - [Lyrics Providers](#lyrics-providers)
  - [Projects & Lyrics Persistence](#projects--lyrics-persistence)
  - [Project URLs & Slugs](#project-urls--slugs)
  - [Featured Artists](#featured-artists)
  - [Account Names](#account-names)
  - [Link Previews (Open Graph)](#link-previews-open-graph)
  - [Gamification](#gamification)
  - [Background Jobs](#background-jobs)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [Testing](#testing)
- [Operational Notes](#operational-notes)
- [License](#license)

## Architecture

```text
Client (React 19)
  │
  ├── REST        → Fastify 5          CRUD, auth, uploads, admin, ASR
  ├── GraphQL     → Mercurius          social reads: profiles, feed, explore, playlists
  └── WebSocket   → Socket.IO          project updates, autosave acks, notifications, ASR progress

Fastify 5
  ├── Mongoose 8  → MongoDB
  ├── Cloudinary  → signed direct uploads (binary never transits this server)
  └── Groq        → Whisper transcription for Auto Stamp
```

The split is deliberate: **REST** handles mutations, file handling and anything needing specific HTTP semantics; **GraphQL** handles read-heavy social queries where clients want to shape the response. `loaders.ts` provides DataLoader-style batching to prevent N+1 queries. Introspection is disabled in production and query depth is capped at 12.

Layering within a module is strict — routes register and declare `preHandler` chains, controllers translate HTTP to service calls, services hold all business logic and own every Mongoose query. Controllers never contain business logic, and services never know about `FastifyRequest`.

## Module Map

| Module | Responsibility |
|---|---|
| `auth` | Register, login, passkey (WebAuthn), Google OAuth OTT exchange, sessions, refresh-token rotation, appeals, env-based superadmin bootstrap |
| `password-reset` / `email-verification` | Transactional token flows, separate from `auth` |
| `projects` | Project CRUD, clone/fork, share, star, boost, forks-enabled toggle, readable URL slugs, the “a project must be nameable” rule |
| `artists` | Per-user artist records, own-library autocomplete, and the legacy-artist-string migration (see [Featured Artists](#featured-artists)) |
| `lyrics` | Parse LRC/SRT/TXT, compile to LRC/SRT, bulk-shift, global offset, duplicate detection, end-time inference |
| `asr` | **Auto Stamp** — Groq Whisper transcription, yt-dlp YouTube audio extraction, lyric/transcript alignment, job store |
| `genius` | Lyrics search and import via a multi-provider chain (see [Lyrics Providers](#lyrics-providers)) |
| `uploads` | Cloudinary signed URLs for audio/avatar/cover, media records, YouTube URL persistence |
| `song-metadata` | Track metadata lookup (Spotify API as provider, Last.fm as fallback) |
| `youtube` | oEmbed metadata fetch |
| `settings` | Per-user settings with per-path diff sync; partial updates merge field by field |
| `admin` | Ban/unban, appeals, IP & device blocking, role assignment, per-role permission presets, audit logs, shadow ban |
| `blocks` | User-to-user blocking (distinct from admin network blocks) |
| `requests` | Staff proposal workflow — GraphQL-only, payload-whitelisted, atomic claim on approval |
| `badges` | Badge definitions, grant/revoke, retroactive scans, XP rewards |
| `progression` | XP and level progression |
| `stats` | Addiction levels, leaderboard ranking |
| `activity` | Activity feed and the private authoring heatmap |
| `explore` | Trending and popular queries |
| `reactions` | Emoji reactions on projects and comments |
| `notifications` | Read/unread state, real-time delivery |
| `users` | Public user lookup and profile reads; account-name history (old names keep resolving) |
| `user_logs` | `UserActionLog` — written by services, never by controllers |
| `og` | Link-preview metadata (`/og/meta`), crawler pages and card images for projects, profiles and lists |
| `email` | SMTP transport |
| `health` | Health check |

## API Reference

Every route, its guard, and its request/response shape.

**Conventions.** All responses are JSON unless noted. Every request should send `X-Device-Id`; `/auth` routes **require** it. Cookies (`credentials: 'include'`) carry auth — tokens are never in bodies. `lines[]` is the shared lyric-line array (`text`, `timestamp`, `endTime`, `secondary`, `translations[]`, `words[]`, `type`, `label`, `singers[]`). Errors are `{ error: string }` with a stable code, plus `{ retryAfter }` on 429.

**Guards** (Fastify decorators, see [Permissions](#permissions)):

| Guard | Meaning |
|---|---|
| — | Public |
| `optionalAuth` | Sets `userId` if a valid token is present; never rejects |
| `requireAuth` | 401 without a valid token; 403 if banned |
| `requireActiveUser` | `requireAuth` + device/IP ban checks |
| `requireAuthForAppeal` | `requireAuth` without the ban check |
| `requireStaff` | Must hold at least one permission |
| `perm(x)` | Must hold permission `x` |
| `sudo` | Valid `adminSudo` cookie (5-minute TTL) |
| `requireSuperadmin` | Literal `role === 'superadmin'` |

### `/health`

| Method | Path | Guard | Request | Response |
|---|---|---|---|---|
| GET | `/health/live` | — | — | `{ status: 'ok' }` |
| GET | `/health/ready` | — | — | `{ status, checks: { database } }` — 503 if DB errored |
| GET | `/health` | — | — | Full health report — 503 if errored |

### `/auth`

Rate limits here key on **IP only**, never on the client-supplied device header.

| Method | Path | Guard | Rate | Request | Response |
|---|---|---|---|---|---|
| POST | `/register` | — | 3/h | `{ accountName? , email?, password, recaptchaToken? }` (one of accountName/email required; password ≥8) | Sets auth cookies → `{ user }` |
| POST | `/login` | — | 10/min | `{ identifier, password, recaptchaToken? }` | Sets auth cookies → `{ user }` |
| POST | `/check-identifier` | — | 10/min | `{ identifier }` | `{ exists, methods }` — which sign-in methods apply |
| POST | `/refresh` | — | — | Body ignored; reads the `refreshToken` **cookie** | Rotates both cookies → `{ user }` |
| POST | `/logout` | `optionalAuth` | — | — | Clears cookies |
| GET | `/me` | `requireAuth` | — | — | `{ user }` |
| PATCH | `/profile` | `requireAuth` | — | `{ avatarUrl?, avatarPublicId?, accountName?, email?, bio? }` (bio ≤160) | `{ user }` |
| POST | `/appeal` | `requireAuthForAppeal` | — | `{ message }` | `{ ok }` |
| POST | `/forgot-password` | — | 10/min | `{ email }` | `{ ok }` (never reveals existence) |
| GET | `/reset-password/validate` | — | 10/min | `?token` | `{ valid }` |
| POST | `/reset-password` | — | 10/min | `{ token, password }` | `{ ok }` |
| POST | `/change-password` | `requireAuth` | — | `{ currentPassword, newPassword }` | `{ ok }` |
| POST | `/set-password` | `requireAuth` | — | `{ password }` — for OAuth-only accounts | `{ ok }` |
| POST | `/verify-email` | — | 10/min | `{ token }` | `{ ok }` |
| GET | `/sessions` | `requireAuth` | — | — | `[{ id, deviceId, ip, userAgent, createdAt, expiresAt, current }]` |
| DELETE | `/sessions/:id` | `requireAuth` | — | — | `{ ok }` |
| POST | `/logout-all` | `requireAuth` | — | — | Revokes every session |
| GET | `/passkey/register/options` | `requireAuth` | — | — | WebAuthn `PublicKeyCredentialCreationOptions` |
| POST | `/passkey/register/verify` | `requireAuth` | — | WebAuthn attestation response | `{ verified }` |
| POST | `/passkey/login/options` | — | 10/min | `{ identifier? }` | WebAuthn `PublicKeyCredentialRequestOptions` |
| POST | `/passkey/login/verify` | — | 10/min | WebAuthn assertion response | Sets auth cookies → `{ user }` |
| GET | `/passkeys` | `requireAuth` | — | — | `[{ id, name, createdAt, transports }]` |
| DELETE | `/passkeys/:id` | `requireAuth` | — | — | `{ ok }` |
| POST | `/deactivate` | `requireAuth` | — | — | Soft-deletes the account |
| POST | `/exchange-ott` | — | 20/min | `{ ott }` — the Google one-time token | Sets auth cookies → `{ user }` |

### `/projects`

> **Note:** the REST `/projects` routes are no longer registered — project CRUD is served by GraphQL (`createProject`, `updateProject`, `deleteProject`, `cloneProject`; see [GraphQL](#graphql--post-graphql)). The table below shows the legacy request shapes. Artists, slugs and the “nameable project” rule are described in [Featured Artists](#featured-artists) and [Project URLs & Slugs](#project-urls--slugs).

| Method | Path | Guard | Request | Response |
|---|---|---|---|---|
| POST | `/projects` | `requireActiveUser` | `{ title?, uploadId?, lyrics?, state?, metadata?, readOnly?, public?, ytUrl?, uploadUrl?, uploadPublicId?, fileName?, duration?, recaptchaToken? }` | `{ project }` with a nanoid(10) `publicId` |
| GET | `/projects` | `requireActiveUser` | — | `{ projects }` |
| GET | `/projects/:id` | `optionalAuth` | `:id` = `publicId` | `{ project, lyrics, upload }` |
| PUT | `/projects/:id` | `requireActiveUser` | Full project body (as POST) | `{ project }` |
| PATCH | `/projects/:id` | `requireActiveUser` | Any subset, plus `version` and `saveKind: 'manual'\|'auto'` | `{ project, version }`; emits `project:updated` + `autosave:ack` |
| DELETE | `/projects/:id` | `requireActiveUser` | — | `{ ok }` |
| GET | `/projects/share/:id` | — | — | Read-only project for shared links |

`lyrics` in a PATCH accepts either a full replace or a surgical positional patch:

```jsonc
// full replace
{ "lyrics": { "editorMode": "lrc", "language": "en", "sections": [ { "label": "Verse", "singers": [], "lines": [] } ] } }

// single line   → sections.<sectionIdx>.lines.<lineIdx>
{ "lyrics": { "sectionIdx": 0, "lineIdx": 4, "line": { "text": "…", "timestamp": 63.42 } } }

// single word   → …lines.<lineIdx>.words.<wordIndex>
{ "lyrics": { "sectionIdx": 0, "lineIdx": 4, "wordIndex": 2, "word": { "word": "close", "time": 11.4 } } }
```

Bounds: `sectionIdx ≤ 2000`, `lineIdx ≤ 10000`, `wordIndex ≤ 2000`.

### `/lyrics` and `/editor` — parsing & editor operations

The same router is mounted under **both** prefixes, so every route below answers at `/lyrics/…` *and* `/editor/…`. All are public and stateless — they transform `lines[]` and return it.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/parse` | `{ content, filename? }` (≤5 MB; extension picks LRC/SRT/TXT) | `{ lines, detectedFormat, count, metadata, artists }` — see below |
| POST | `/compile/lrc` | `{ lines, includeTranslations?, includeSecondary?, precision?: 'hundredths'\|'thousandths', wordPrecision?, metadata?, includeFeaturedInTitle?, lineEndings?: 'lf'\|'crlf', exportTranslationIndex? }` | `{ output, format }` |
| POST | `/compile/srt` | `{ lines, duration?, includeTranslations?, includeSecondary?, lineEndings?, srtConfig? }` | `{ content }` |
| POST | `/infer-end-times` | `{ lines, duration?, srtConfig? }` | `{ lines }` |
| POST | `/mark` | `{ lines, activeLineIndex, time, editorMode, settings, activeWordIndex?, stampTarget?: 'main'\|'secondary', awaitingEndMark?, lastAction? }` | `{ lines, activeLineIndex, awaitingEndMark }` |
| POST | `/bulk-shift` | `{ lines, selectedIndices, delta }` | `{ lines }` |
| POST | `/global-offset` | `{ lines, delta }` | `{ lines }` |
| POST | `/clear-all` | `{ lines, isSrt?, isWords? }` | `{ lines }` |
| POST | `/clear-line` | `{ lines, index, isSrt?, isWords? }` | `{ lines }` |
| POST | `/detect-duplicates` | `{ lines, threshold? }` | `{ duplicates }` |

**Featured artists in LRC files.** `POST /compile/lrc` accepts `metadata.artists` (`[{ name, role }]`): `[ar:]` is then the formatted credits (`Drake feat. Rihanna & Kanye`), overriding a plain `metadata.ar`. `[ti:]` stays the plain title unless `includeFeaturedInTitle` is `true`, which writes `Title (feat. Rihanna & Kanye)`. When the body omits `includeFeaturedInTitle`, a signed-in request (session cookie) falls back to the user's saved `settings.export.includeFeaturedInTitle`; anonymous requests get `false`; an explicit `true`/`false` always wins. Invalid credits → `422 { error, code }`.

`POST /parse` also returns the file's header tags and what the shared parser makes of them (for `.lrc`/`.txt`; `{}`/`null` otherwise):

```jsonc
{ "metadata": { "ti": "Song (feat. B)", "ar": "A & B" },
  "artists": { "credits": [{ "name": "A", "role": "primary", "order": 0 }],
               "title": "Song", "display": "A feat. B",
               "flags": [{ "code": "ambiguous_separator", "source": "artist", "text": "A & B" }] } }
```

### `/lyrics` — search & import

`optionalAuth`, 20 requests/minute. See [Lyrics Providers](#lyrics-providers).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/lyrics/search` | `?q` (required) | `{ results: [{ id, title, artist, album?, duration?, synced?, thumbnail, url, provider }] }` — `id` is namespaced (`lrclib:123`) when resolvable |
| GET | `/lyrics/extract` | `?track` (required), `?artist`, `?album`, `?duration`, `?id` | `{ lyrics, synced, provider }` · `422 lyrics_unavailable` if no provider has it |

### `/asr` — Auto Stamp

All routes `requireAuth`, 10 requests/hour. Progress also streams over Socket.IO as `asr:progress`.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/asr/stamp` | `{ lines: [{ index, text, wordTokens? }], fuzzyTolerance?: 0.5–1 }` plus **exactly one** of `uploadId` or `youtubeUrl` (both or neither → 400) | `{ jobId }` |
| POST | `/asr/stamp/upload` | `multipart/form-data`: the `payload` field (`{ lines, fuzzyTolerance? }` as JSON) **must precede** the `file` part; ≤50 MB, 1 file | `{ jobId }` |
| GET | `/asr/jobs/:id` | — | `{ jobId, phase, result?, errorCode? }` · **404** if not yours |
| GET | `/asr/jobs/:id/audio` | — | Extracted audio bytes (for the waveform) · 404 if not yours |
| POST | `/asr/jobs/:id/cancel` | — | `{ cancelled }` |

`phase` ∈ `starting, fetching_audio, extracting_audio, transcribing, aligning, applying, completed, failed, cancelled`. Each `result[]` entry is `{ index, timestamp, endTime, confidence, status, words }` with `status` ∈ `matched, partial, low, none`.

Error codes: `asr_invalid_key`, `asr_no_audio`, `asr_unsupported_audio`, `asr_empty_transcript`, `asr_rate_limited`, `asr_timeout`, `asr_network`, `asr_cancelled`, `asr_malformed_response`, `asr_youtube_blocked`, `asr_youtube_unavailable`, `asr_ytdlp_not_configured`, `asr_job_not_found`.

### `/uploads`

| Method | Path | Guard | Rate | Request | Response |
|---|---|---|---|---|---|
| POST | `/signature` | `optionalAuth` | — | `{ fileName, fileSize }` (≤50 MB), `recaptchaToken?` | `{ signature, timestamp, apiKey, cloudName, folder }` |
| POST | `/avatar-signature` | `requireAuth` | 5/h | — | Signed Cloudinary params |
| POST | `/cover-signature` | `requireAuth` | 20/h | — | Signed Cloudinary params |
| GET | `/media` | `requireActiveUser` | — | `?limit` (≤100, default 50), `?offset` | `{ uploads }` |
| GET | `/media/:id` | `requireActiveUser` | — | — | `{ upload }` |
| POST | `/media` | `requireActiveUser` | — | `{ source: 'cloudinary'\|'youtube', uploadUrl?, publicId?, fileName?, title?, duration? }` | `{ upload }` |
| PATCH | `/media/:id` | `requireActiveUser` | — | `{ title?, fileName?, duration? }` | `{ upload }` |
| DELETE | `/media/:id` | `requireActiveUser` | — | — | `{ ok }` |

The binary never transits this server — the client uploads straight to Cloudinary with the signature, then records it via `POST /media`.

### `/settings`

> **Note:** settings are read and written through GraphQL (`settings`, `updateSettings`, `resetSettings`); the REST routes below are legacy. `updateSettings` merges **field by field**: sending `{ export: { stripEmptyLines: true } }` no longer erases the other `export` fields. New: `export.includeFeaturedInTitle` (boolean, reads as `false` when never set).

All `requireAuth`. Bodies are validated against the full settings tree (`playback`, `editor`, `export`, `interface`, `shortcuts`, `import`, `advanced`, `autoStamp`).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/settings` | — | `{ settings }` |
| PUT | `/settings` | Complete settings object | `{ settings }` |
| PATCH | `/settings` | Partial settings (deep-merged) | `{ settings }` |
| DELETE | `/settings` | — | Resets to defaults |

### `/notifications`

All `requireAuth`. Delivered live over Socket.IO as well.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/notifications` | — | `{ notifications, unreadCount }` |
| POST | `/notifications/read` | `{ ids }` | `{ ok }` |
| POST | `/notifications/read-all` | — | `{ ok }` |
| DELETE | `/notifications/:id` | — | `{ ok }` |

### `/song-metadata`, `/youtube`, `/google`, `/og`

| Method | Path | Guard | Rate | Request | Response |
|---|---|---|---|---|---|
| GET | `/song-metadata/lookup` | — | 20/min | `?songName` (required), `?artistName` | Track metadata (title, artist, album, year, cover, …) |
| GET | `/youtube/search` | `optionalAuth` | 30/min | `?q` | Search results |
| GET | `/youtube/availability` | `optionalAuth` | 30/min | `?videoId` (11 chars) | Availability plus a specific failure reason |
| GET | `/youtube/check-embed` | `optionalAuth` | 30/min | `?videoId` | **Deprecated** alias returning the legacy `{ embeddable }` shape |
| GET | `/google/auth/url` | `requireAuth` | — | — | `{ url }` — for linking Google to an existing account |
| GET | `/google/login/url` | — | — | — | `{ url }` — for sign-in |
| GET | `/google/auth/callback` | — | — | `?code&state` | HTML that `postMessage`s a one-time token to the opener |
| POST | `/google/disconnect` | `requireAuth` | — | — | `{ disconnected }` · 409 `last_auth_method` if it's the only sign-in method |
| GET | `/og/project/:publicId` | — | — | `?s` (start time), `?list`, `?hl` | **HTML** (not JSON) with Open Graph/Twitter tags and a redirect to the canonical slug URL (`?s` / `?list` preserved), under a per-response CSP nonce · 404 for private/missing |
| GET | `/og/meta` | — | yes | `?path` (a web-app path such as `/32blunts/projects/radiohead-creep-<id>`), `?hl` | JSON link-preview metadata. **Always 200**; a private/missing/hidden resource is byte-identical to a non-existent one. See [Link Previews](#link-previews-open-graph) |
| GET | `/og/image/:type/:id.png` | — | yes | `type` ∈ `project\|profile\|list` | 302 to a 1200×630 card (or the brand card) |

### `/admin`

An `onRequest` hook applies `requireStaff` to **every** route below. Destructive actions additionally need a permission *and* a fresh `sudo` grant. Staff may only act on strictly lower ranks.

| Method | Path | Guard | Request | Response |
|---|---|---|---|---|
| GET | `/sudo/factors` | staff | — | `{ factors }` — which re-auth methods are available |
| POST | `/sudo` | staff | `{ password? }` | Sets the `adminSudo` cookie (5 min) |
| POST | `/sudo/passkey/options` | staff | — | WebAuthn request options |
| POST | `/sudo/passkey/verify` | staff | WebAuthn assertion | Sets the `adminSudo` cookie |
| GET | `/users` | `perm('users.view')` | `?cursor`, `?limit` (≤100), `?search`, `?role`, `?status` ∈ `all\|active\|banned\|pending\|deleted\|verified\|premium` | `{ users, nextCursor }` |
| GET | `/stats` | `perm('stats.view')` | — | Dashboard aggregates |
| GET | `/audit-logs` | `perm('audit.view')` | `?page`, `?limit` (≤100) | `{ logs, total }` |
| GET | `/banned-ips` | `perm('network.block')` | — | `{ ips }` |
| GET | `/banned-devices` | `perm('network.block')` | — | `{ devices }` |
| POST | `/users/:id/ban` | `perm('users.ban')` + sudo | `{ reason?, bannedUntil?, banIp?, banDevice? }` | `{ user }` |
| POST | `/users/:id/unban` | `perm('users.ban')` + sudo | — | `{ user }` |
| POST | `/users/:id/reject-appeal` | `perm('users.ban')` + sudo | — | `{ user }` |
| POST | `/users/:id/shadowban` | `perm('users.shadowban')` + sudo | `{ feed, search, reason? }` | `{ user }` |
| POST | `/users/:id/unshadowban` | `perm('users.shadowban')` + sudo | — | `{ user }` |
| POST | `/users/:id/role` | `perm('users.role')` + sudo | `{ role: 'user'\|'mod'\|'admin'\|'superadmin' }` | `{ user }` |
| DELETE | `/users/:id` | `perm('users.delete')` + sudo | — | `{ ok }` |
| POST | `/users/:id/reactivate` | `perm('users.delete')` + sudo | — | `{ user }` |
| POST | `/banned-ips` | `perm('network.block')` + sudo | `{ ip, reason? }` | `{ entry }` |
| DELETE | `/banned-ips/:id` | `perm('network.block')` + sudo | — | `{ ok }` |
| POST | `/banned-devices` | `perm('network.block')` + sudo | `{ deviceId, reason? }` | `{ entry }` |
| DELETE | `/banned-devices/:id` | `perm('network.block')` + sudo | — | `{ ok }` |
| POST | `/xp` | `perm('xp.adjust')` + sudo | `{ userId, delta, reason? }` | `{ user }` |
| GET | `/permissions` | `requireSuperadmin` | — | `{ permissions, rolePresets, editableRoles }` |
| PUT | `/permissions/roles/:role` | `requireSuperadmin` + sudo | `:role` ∈ `mod\|admin` only; `{ permissions: [] }` | `{ rolePresets }` |
| PUT | `/permissions/users/:id` | `requireSuperadmin` + sudo | `{ permissions: [] }` | `{ user }` |

> Permission management is gated on the literal `role`, not on a permission string — granting permissions *is* the privilege-escalation surface, so it must not be delegable.

### GraphQL — `POST /graphql`

Depth limit 12; introspection disabled in production. Context is `{ userId, bannedUserId, ip, tokenExpired, socketId }`. Unauthenticated mutations throw `UNAUTHORIZED`.

**Queries**

| Query | Arguments | Returns |
|---|---|---|
| `health` | — | `HealthStatus!` |
| `me` | — | `User` |
| `project` | `id: ID!` | `Project` |
| `projects` | `limit, offset` | `[Project!]!` |
| `publicProject` | `publicId: String!` | `Project` |
| `getShare` | `id: ID!` | `Project` |
| `upload` / `uploads` | `id: ID!` / `limit, offset` | `Upload` / `[Upload!]!` |
| `settings` | — | `Settings` |
| `publicProfile` | `accountName: String!, asVisitor: Boolean` | `PublicUser` |
| `followList` | `accountName: String!, type: FollowListType!, offset` | `FollowListResult!` |
| `blockedUsers` | — | `[BlockedUser!]!` |
| `playlist` / `playlists` | `id: ID!` / `accountName: String!` | `Playlist` / `[Playlist!]!` |
| `savedPlaylists` | — | `[Playlist!]!` |
| `feed` | `offset, limit` | `FeedResult!` |
| `userActivity` | `offset, limit` | `FeedResult!` |
| `userActivityHeatmap` | — | `[ActivityHeatmapDay!]!` |
| `searchProjects` | `query: String!, sortBy: SearchSort, offset, limit` | `SearchResult!` |
| `searchUsers` | `query: String!, limit` | `[FollowUser!]!` |
| `trendingProjects` | `offset, limit` | `ProjectPage!` |
| `popularPlaylists` | `offset, limit` | `PlaylistPage!` |
| `suggestedUsers` | `limit` | `[FollowUser!]!` |
| `exploreStats` | — | `ExploreStats!` |
| `projectReactions` | `publicId: String!` | `ProjectReactions!` |
| `leaderboard` | `limit, offset` | `LeaderboardResult!` |
| `badgeDefinitions` | — | `[BadgeDef!]!` |
| `publicBadgeDefinitions` | — | `[PublicBadgeDef!]!` |
| `userShowcase` | `accountName: String!` | `[ShowcasedBadge!]!` |
| `myMusicLibrary` | — | `[MusicLibraryEntry!]!` — primary artists only |
| `myArtistSuggestions` | `prefix: String!, limit, offset` | `ArtistSuggestionPage!` — prefix match over **the caller's own** artists, `limit` ≤ 20 |
| `parseArtists` | `artist: String!, title: String` | `ParsedArtists!` — what the shared parser reads out of an artist string / title (credits, cleaned title, flags, display) |
| `userContentStats` | — | `ContentStats!` |
| `adminAddictionLevels` | — | `[AddictionLevel!]!` |
| `myPreferences` | — | `UserPreferences!` |
| `myRequests` / `pendingRequests` / `reviewedRequests` | — | `[StaffRequest!]!` |
| `requestCapabilities` / `requestCounts` | — | `RequestCapabilities!` / `RequestCounts!` |

**Mutations**

| Mutation | Arguments | Returns |
|---|---|---|
| `createProject` | `input: CreateProjectInput!` | `Project!` |
| `updateProject` | `id: ID!, input: UpdateProjectInput!` | `Project!` |
| `deleteProject` | `id: ID!` | `Boolean!` |
| `updateLyrics` | `publicId: String!, input: UpdateLyricsInput!` | `Lyrics!` |
| `cloneProject` | `id: ID!` | `Project!` — fork |
| `starProject` / `unstarProject` | `id: ID!` | `Project!` |
| `boostProject` | `publicId: ID!` | `Boolean!` |
| `setForksEnabled` | `publicId: ID!, enabled: Boolean!` | `Project!` |
| `reactToProject` | `publicId: String!, emoji: String!` | `ProjectReactions!` |
| `incrementProjectView` / `incrementProjectShare` | `id: ID!` | `Boolean!` |
| `incrementPlaylistView` / `incrementPlaylistShare` | `id: ID!` | `Boolean!` |
| `updateProfile` | `input: UpdateProfileInput!` (`accountName`, `displayName`, `email`, `bio`, `avatarUrl`) | `User!` |
| `updateSettings` / `resetSettings` | `input: UpdateSettingsInput!` / — | `Settings!` / `Boolean!` |
| `updatePreferences` | `input: UpdatePreferencesInput!` (visibility, notification toggles, `showActivityHeatmap`, mini-profile badges) | `UserPreferences!` |
| `saveMedia` / `deleteMedia` | `input: SaveMediaInput!` / `id: ID!` | `Upload!` / `Boolean!` |
| `sendVerificationEmail` | — | `Boolean!` |
| `follow` / `unfollow` | `accountName: String!` | `Boolean!` |
| `blockUser` / `unblockUser` | `accountName: String!` | `Boolean!` |
| `createPlaylist` | `input: CreatePlaylistInput!` | `Playlist!` |
| `updatePlaylist` | `id: ID!, input: UpdatePlaylistInput!` | `Playlist!` |
| `deletePlaylist` | `id: ID!` | `Boolean!` |
| `addProjectToPlaylist` / `removeProjectFromPlaylist` | `playlistId: ID!, publicId: ID!` | `Playlist!` |
| `reorderPlaylist` | `playlistId: ID!, publicIds: [ID!]!` | `Playlist!` |
| `savePlaylist` / `unsavePlaylist` | `playlistId: ID!` | `Boolean!` |
| `updateShowcase` | `badgeIds: [String!]!, showcasePublic: Boolean` | `UpdateShowcaseResult!` |
| `adminGrantBadge` | `userIdentifier: String!, badgeId: String!` | `Boolean!` |
| `adminRevokeBadge` | `userId: ID!, badgeId: String!` | `Boolean!` |
| `adminCreateBadge` / `adminUpdateBadge` | `input: BadgeDefInput!` / `id: String!, input` | `BadgeDef!` |
| `adminDeleteBadge` | `id: String!` | `Boolean!` |
| `adminRetroactiveScan` | `badgeId: String!` | `RetroactiveResult!` |
| `adminCreateAddictionLevel` / `adminUpdateAddictionLevel` | `input` / `id: String!, input` | `AddictionLevel!` |
| `adminDeleteAddictionLevel` | `id: String!` | `Boolean!` |
| `adminShadowBan` | `userId: ID!, feed: Boolean!, search: Boolean!, reason: String` | `Boolean!` |
| `adminUnshadowBan` | `userId: ID!` | `Boolean!` |
| `submitRequest` | `type: String!, payload: String!` (JSON string, whitelisted server-side) | `StaffRequest!` |
| `reviewRequest` | `id: ID!, decision: String!, note: String` | `StaffRequest!` — atomic claim; self-review refused |

**Notes on inputs and results**

- **Project metadata.** `Project.slug` (`String!`) is the readable URL slug; `Project.metadata.artists` is `[ArtistCredit!]!` and `metadata.songArtist` is the **derived, read-only** display string. `ProjectMetadataInput.songArtist` was removed; send `artists: [{ name, role }]` instead (omitted = keep, `[]` = clear). See [Featured Artists](#featured-artists).
- **Errors.** `createProject` / `updateProject` fail with `extensions: { code, status }`: `project_identity_required` (422) and the `artist_*` / `artists_*` codes listed under [Featured Artists](#featured-artists).
- **Account names.** `publicProfile`, `followList`, `userShowcase` and `playlists` also accept a *former* account name and return the user's **current** `accountName`; the client redirects. See [Account Names](#account-names).
- **Settings.** `updateSettings` merges per field (see [`/settings`](#settings)); `settings { export { includeFeaturedInTitle } }` is the saved default for the LRC export option.

### Socket.IO

Clients join `user:{userId}` and `project:{publicId}` rooms.

| Event | Direction | Payload |
|---|---|---|
| `project:updated` | → client | Broadcast to the project room after a successful patch |
| `autosave:ack` | → client | To the originating socket only |
| `asr:progress` | → client | `{ jobId, phase, result?, errorCode? }` |
| `notification` | → client | New notification |
| `session:invalidated` | → client | Forces a client-side logout |

## Key Subsystems

### Authentication & Sessions

Three methods: **password** (Argon2), **passkey** (WebAuthn via `@simplewebauthn/server`), and **Google OAuth** (popup → one-time token → `POST /auth/exchange-ott`).

Access and refresh tokens are both JWTs delivered as `httpOnly` cookies. Every refresh rotates the token and stores its hash; a short replay window is allowed via `previousRefreshTokenHash`. Replaying a rotated token after that window invalidates the whole session `familyId` as theft detection. Clients refresh at 75% of access-token lifetime and coalesce concurrent refreshes so races don't look like theft.

> **Guest project migration is load-bearing.** Unauthenticated users build projects in `localStorage`. Every successful auth path must migrate that draft to the new account. If you add an auth route, wire migration into it — and never clear the local copy on failure.

### Permissions

`role` is **descriptive only and never grants access.** Authorization always reads `user.permissions[]`.

Enforce at the route level with `fastify.requirePermission('badges.manage')`, `fastify.requireStaff`, `fastify.requireSudo`, or `fastify.requireSuperadmin`, and re-check inside the service for every mutation. When staff act on staff, compare `rankOf()` — an actor may only affect strictly lower ranks. Destructive admin actions additionally require a 5-minute `adminSudo` cookie.

Role presets live in `shared/permissions.ts` and can be overridden per role in the DB for `mod` and `admin` only; `user` and `superadmin` are never DB-overridable. **Superadmin is granted exclusively by the `SUPERADMIN_EMAIL` env var** — never through any HTTP route or UI. It is grant-only and never demotes; revocation is a deliberate manual step via `scripts/grant-role.ts`.

### Auto Stamp (ASR)

Transcribes audio and aligns it to the user's lyrics so a song can be timed without manual marking.

1. **Resolve audio** — YouTube URL (extracted with yt-dlp), Cloudinary `uploadId`, or a directly uploaded file.
2. **Transcribe** — Groq `whisper-large-v3` with `timestamp_granularities[]=word`.
3. **Align** — Needleman-Wunsch global alignment between lyric tokens and transcript tokens, over NFKC-normalized text with Levenshtein per-token similarity. Monotonic by construction, which is what keeps repeated choruses in order.
4. **Stage** — results are returned for confirmation, not written directly. Each line gets a confidence score and a `matched | partial | low | none` status.

YouTube is fully supported; it is not a local-file-only feature. Caps: 20-minute videos, 25 MB audio, 3 concurrent extractions.

This module carries most of the server's untrusted-input surface, so its guards matter:

- Cloudinary fetches require `https:` with hostname exactly `res.cloudinary.com` and pass `redirect: 'error'`, so a redirect can't walk off the validated host.
- Byte limits are enforced twice — `Content-Length` and again on the actual stream — because a missing or lying header must not become an OOM.
- yt-dlp is spawned with `shell: false` and an argv built entirely server-side from a video ID validated against `/^[A-Za-z0-9_-]{11}$/`. Never interpolate user strings into those arguments.
- Job reads compare ownership and return **404, not 403**, so job IDs can't be probed.

### Lyrics Providers

`GET /lyrics/extract` runs a chain, each provider isolated so one failing upstream falls through instead of failing the request:

| Order | Provider | Key required | Synced lyrics |
|---|---|---|---|
| 1 | [LRCLIB](https://lrclib.net) | No | **Yes** — returns LRC |
| 2 | LyricFind | Yes (commercial) | Depends on licence |
| 3 | [lyrics.ovh](https://api.lyrics.ovh) | No | No |

**Nothing here needs configuring.** With no keys at all, search falls back to LRCLIB and lookup runs LRCLIB → lyrics.ovh. LRCLIB is primary because it is the only source returning already-timestamped LRC — a hit lets the user skip both manual syncing and transcription entirely. It identifies itself via `APP_URL`.

`GET /lyrics/search` prefers Genius when `GENIUS_CLIENT_ACCESS_TOKEN` is set (cover art, better fuzzy matching) and falls back to LRCLIB otherwise. Responses are `{ lyrics, synced, provider }`.

LyricFind is gated on `LYRICFIND_API_KEY` and is a silent no-op without one, since it requires a commercial agreement and has no free tier. Its request/response shape follows LyricFind's documented `lyric.do` interface but **has not been verified against a live key** — confirm field names against your contract docs when credentials arrive.

### Projects & Lyrics Persistence

Lyrics are stored as nested `sections[]`, each holding `lines[]`. The client works with a flat array and converts at the boundary (`flatToSections` / `sectionsToFlat`). Never accept flat lines directly.

`PATCH /projects/:id` accepts either a full `sections` replacement or a surgical positional patch (`{ sectionIdx, lineIdx, line }`, optionally down to `{ wordIndex, word }`). Positional fields **must** be declared in `projects.schema.ts` — AJV runs with `removeAdditional`, so an undeclared field is silently stripped and the patch becomes a no-op. Index bounds in the schema mirror the service's `MAX_*_INDEX` constants; keep them in sync.

After a successful patch the server emits `project:updated` to the `project:{id}` room and `autosave:ack` to the originating socket.

### Project URLs & Slugs

| Page | URL |
|---|---|
| Public project | `/:accountName/projects/:slug-:publicId` |
| Editor (owner) | `/:accountName/projects/:slug-:publicId/edit` |
| Profile / playlist | `/:accountName` · `/:accountName/lists/:listId` |
| Legacy (still parsed) | `/project/:publicId`, `/profile/:accountName[/lists/:id]`, `/u/:accountName` |

The slug and account name in a URL are **cosmetic**. A project is always resolved by `publicId` — the *last 10 characters* of the final path segment (the nanoid alphabet contains `-`, so the id cannot be found by splitting) — so renames never break a link and no slug history is kept.

`src/utils/project-slug.ts` is the single source of the slug (the web client mirrors it): NFD-fold Latin diacritics (kana dakuten is kept), lower-case, drop apostrophes, keep letters and digits of **any** script, collapse the rest to `-`, cap at 60 characters. The slug is `slugify(artist display + " " + song name)`, else `slugify(title)`, else empty (the URL is then just the id). `projectPath()` builds the full path.

`Project.slug` is **derived, never client input**. A pre-validate hook sets it on create/save, and every `findOneAndUpdate` path that writes `title` or `metadata` sets it in the same write. GraphQL's `slug` falls back to computing it when a row has none stored yet, so rows are valid before the backfill runs.

**A project must be nameable.** `title`, `metadata.songName` or an artist must contain at least one letter or digit, otherwise create/update fails with `project_identity_required` (422). An update is only refused if it would remove the *last* of them, so unrelated edits to a legacy row are never blocked. A fork of a nameless source gets a fallback title (upload title → file name → `untitled`). Titles are trimmed and capped at 200 characters, song names at 500.

`pnpm tsx scripts/backfill-project-slugs.ts` fills `slug` for existing projects (batched, idempotent, `--dry-run`, `--recompute`; it does not touch `updatedAt`). Nameless legacy rows get the fallback title and are counted in the log.

### Featured Artists

A song has an ordered list of **credits**, each `primary` or `featured`:

- **Storage.** `Project.metadata.artists: [{ artistId, name, role, order }]`, backed by a per-user `artists` collection (`userId` + case-insensitive name, unique). `metadata.songArtist` is the **derived display string** (`Drake feat. Rihanna & Kanye`) that search, OG, slugs and old readers keep using; it is no longer accepted as input. Legacy rows keep their original `songArtist` text until migrated.
- **Shared code.** `src/utils/artists.ts` holds the parser, formatter and validator and has no imports, so the client copies it verbatim; its test file is the behavioural spec.
- **Formatter.** `A` · `A & B` · `A, B & C` for primaries; featured follows as `feat. A` · `feat. A & B` · `feat. A, B & C` (`Primary feat. A & B`).
- **Parser.** Reads `feat.` / `feat` / `ft.` / `ft` / `featuring` (and `with` only inside brackets), case-insensitively, inside or outside nested brackets, from both the artist string and the title (returning the cleaned title). Names split on `,` `&` `and` `x`. Doubtful cases are **flagged, never guessed**: `ambiguous_separator` (*Simon & Garfunkel*), `weak_marker` (bare `ft` / `feat`), `empty_feat_segment`, `unbalanced_bracket`, `duplicate_removed`.
- **Validation** (422, `extensions.code`): `artists_invalid`, `artist_role_invalid`, `artist_name_empty`, `artist_name_too_long` (> 300), `artists_too_many` (> 10), `artist_duplicate` (case-insensitive, any role), `artist_primary_required` (a non-empty list needs a primary; `[]` is valid).
- **Writes.** Send `metadata.artists`; omitted keeps the stored credits, `[]` clears them. `artistId` is never accepted: ids are resolved by name inside the owner's own records. A fork re-links the credits to the forker's records. The music library stores **primary** artists only.
- **Autocomplete.** `myArtistSuggestions(prefix, limit ≤ 20, offset)` searches only the caller's own artist names, case-insensitive prefix, plain text (no patterns).
- **Search.** Featured names are part of `songArtist`, so existing search paths match them; no Atlas index change is needed.
- **Migration.** `pnpm tsx scripts/migrate-artists.ts` converts legacy strings and is a **dry run by default** (`--write` applies, `--include-ambiguous` also applies `&`/`and`/`x` and bare-`ft` rows, `--report file.json` saves the report). A title / song name loses its `feat.` segment only when it was moved into `artists`, and is never emptied. Malformed rows are never applied. Re-runs are safe.

Full request/response shapes, error messages and the client notes are in [`docs/featured-artists-api.md`](docs/featured-artists-api.md).

### Account Names

Renaming an account records the old name in `account_name_history`, so old links keep working:

- Name lookups from a URL (`publicProfile`, `followList`, `userShowcase`, `playlists`, and OG) check **current** names first and only then the history (newest row first). The payload carries the user's *current* `accountName`; the client compares it with the URL and redirects.
- An old name is **never reissued** to someone else (sign-up and rename both refuse it); the previous owner can take it back, which releases it from their history. The history index is deliberately not unique — uniqueness of a *claimed* name is enforced in code.
- `RESERVED_USERNAMES` (`modules/auth/auth.validation.ts`) covers every top-level web-app route segment, because `/:accountName` shares the root with the app's own routes (`admin`, `explore`, `feed`, `library`, `login`, `notifications`, `profile`, `project`, `projects`, `search`, `settings`, `u`, `og`, `api`, …).

### Link Previews (Open Graph)

`GET /og/meta?path=` takes a web-app path and returns the metadata the client's crawler proxy renders; `GET /og/project/:id` renders the same metadata as HTML. Both go through `og.meta.service.ts`.

- **Paths understood:** `/`, `/explore`, `/leaderboard`, `/:accountName`, `/:accountName/lists/:id`, `/:accountName/projects/:slug-:id[/edit]`, plus the legacy `/project/:id` and `/profile/...` forms. Every captured segment is shape-validated before it reaches a query.
- **Canonical URLs:** projects → `/<owner>/projects/<slug>-<id>`, profiles → `/<accountName>`, lists → `/<accountName>/lists/<id>` (legacy URLs report the new canonical).
- **Project title:** `Song – Artist, Synced by owner | LRC Studio` (Spanish: `Sincronizado por`), the same text as the web client's tab title. Song falls back to the project title, then the site name; the artist is the derived display string; the owner is the *current* account name. Without an artist the part is dropped; without an owner (legacy fallback) so is `Synced by …`. Profile and list titles keep ` — LRC Studio`. The strings live in `og.strings.ts`; everything is HTML-escaped by the renderer.
- **Hidden resources** (private project, banned/deleted/shadow-banned owner, unknown path) all return one neutral payload, so nothing leaks and existence cannot be probed.

### Gamification

XP and levels, badge definitions with condition types, admin-defined addiction level tiers, and activity streaks tracked via `streak.lastActiveDate`. Streaks reset on UTC day boundaries and users are warned before one lapses.

The activity heatmap reads `heatmap_days`, which holds `projectsCreated` and `editedProjects` per user per UTC day. `editedProjects` counts **distinct projects that received a saved content change**, from autosave and manual save alike — so ticking autosave on one project all day contributes 1. Deduplication inserts into `heatmap_project_edits` (unique on `{userId, projectId, day}`) and only increments the counter when that insert succeeds, which keeps concurrent saves of the same project from double-counting. These counters never reach the public activity feed.

### Background Jobs

Scheduled in `plugins/cron.ts` with `setInterval`/`setTimeout` rather than a cron library:

| Job | Schedule |
|---|---|
| `recomputeTrendingScores` + `recomputeLeaderboardRanking` | Hourly |
| `sweepJobs` | Hourly — evicts terminal ASR jobs past their 10-minute TTL |
| `runStreakWarnings` | Frequent tick, acts at `STREAK_WARNING_HOUR_UTC`; idempotent per user per UTC day |
| `archiveDeletedUsers` | Weekly, Sunday 02:00 UTC |
| `seedBuiltinBadges`, `seedAddictionLevels`, `syncRolePermissions`, `syncSuperadminEmailGrant` | Once at startup, all idempotent |

TTL indexes: activities 365 days, `heatmap_days` 400 days, `heatmap_project_edits` 2 days, admin logs 90 days, banned IPs/devices 2 years, sessions on `expiresAt`.

## Getting Started

### Prerequisites

- **Node.js ≥ 20.3.0** (enforced via `engines`)
- **pnpm** — both packages use `pnpm-lock.yaml`
- A MongoDB instance (local or Atlas)
- Optional: `yt-dlp` on `PATH` for Auto Stamp on YouTube sources

### Installation

```bash
git clone https://github.com/crimsonCarnival/lrc-studio.git
cd lrc-studio/server

pnpm install
cp .env.example .env    # set MONGODB_URI, JWT_SECRET, COOKIE_SECRET
pnpm dev                # http://localhost:3000
```

The whole stack (client, server, MongoDB) can also be started from the repository root:

```bash
docker-compose up -d --build
```

## Environment Variables

`.env.example` documents every variable. Only a handful are genuinely required.

**Required** (the server refuses to boot in production without them):

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Database connection string |
| `JWT_SECRET` | Signs access and refresh tokens |
| `COOKIE_SECRET` | Cookie signing — must differ from `JWT_SECRET` |
| `CORS_ORIGIN` | Comma-separated allowed origins |

**Notable optional variables:**

| Variable | Without it |
|---|---|
| `SUPERADMIN_EMAIL` | No one can be granted superadmin. Comma-separated list, matched case-insensitively and exactly |
| `GROQ_API_KEY` | Auto Stamp returns `asr_invalid_key`; nothing else is affected |
| `YTDLP_PATH` / `YTDLP_POT_PROVIDER_URL` | Auto Stamp can't use YouTube sources. The PO-token provider is effectively required in production — datacenter IPs are bot-checked by YouTube without one |
| `GENIUS_CLIENT_ACCESS_TOKEN` | Lyrics search falls back to LRCLIB (which still works, and reports which results are synced) |
| `LYRICFIND_API_KEY` | LyricFind is skipped silently |
| `CLOUDINARY_*` | No audio, avatar or cover uploads |
| `EMAIL_SMTP_*` | Verification and password-reset emails don't send |
| `RECAPTCHA_SECRET_KEY` | Bot protection on register/upload is inert |
| `TRACK_METADATA_*`, `LASTFM_API_KEY` | Song metadata lookup unavailable. Last.fm's signup form asks for a callback URL, but only its *user* auth flow uses one — app-level lookup ignores it, so any URL will do |

Never commit `.env`. Never log or echo secret values.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Watch-mode dev server (`tsx watch`) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run the compiled server |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:coverage` | Coverage report |

One-off maintenance scripts run with `pnpm tsx scripts/<name>.ts` and need `MONGODB_URI`. Both below are idempotent and safe to re-run:

| Script | Purpose |
|---|---|
| `backfill-project-slugs.ts` | Fill `Project.slug` for existing projects. `--dry-run` reports only; `--recompute` also rewrites filled rows |
| `migrate-artists.ts` | Convert legacy `songArtist` strings to structured `artists`. **Dry run unless `--write`**; `--include-ambiguous`, `--report <file>` |

## Testing

Vitest with `mongodb-memory-server`, so suites run against a real in-memory MongoDB rather than mocks.

Suites live next to the code as `*.test.ts`. Pure suites (artist parser/formatter, slugs, OG titles and route parsing, settings merge, LRC export) run anywhere. Database-backed suites use `mongodb-memory-server`, which downloads a `mongod` binary on first run, so they need network access to `fastdl.mongodb.org`; without it they fail at startup rather than at an assertion. Suites that use transactions run on a one-node replica set.

## Operational Notes

Two subsystems keep state in process memory and **break under horizontal scaling**:

- **ASR job store** (`asr/job.store.ts`) — a `Map` with a 10-minute TTL. A client polling `GET /asr/jobs/:id` can hit an instance that never ran the job and receive a spurious 404.
- **Requests pending queue** — an in-memory priority queue.

Both need a DB-backed store before running more than one instance.

## License

MIT.
