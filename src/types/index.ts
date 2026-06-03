// ─── Shared domain types ──────────────────────────────────────────────

export interface WordEntry {
  word: string;
  time: number | null;
  reading?: string;
}

export interface SecondaryWordEntry {
  word: string;
  time: number | null;
}

export interface LineEntry {
  text: string;
  timestamp: number | null;
  endTime?: number | null;
  secondary?: string | null;
  translation?: string | null;
  id?: string;
  words?: WordEntry[];
  secondaryWords?: SecondaryWordEntry[];
}

export interface LyricsData {
  editorMode: 'lrc' | 'srt' | 'words';
  language?: string | null;
  lines: LineEntry[];
}

export interface ProjectState {
  syncMode?: boolean;
  activeLineIndex?: number;
  playbackPosition?: number;
  playbackSpeed?: number;
  saveTime?: string | null;
  timezone?: string | null;
  utcOffset?: string | null;
}

export type PrimaryGenre =
  | 'pop' | 'rock' | 'hip_hop' | 'rnb' | 'electronic'
  | 'jazz' | 'classical' | 'country' | 'folk' | 'metal'
  | 'blues' | 'soul' | 'reggae' | 'latin' | 'alternative'
  | 'soundtrack' | 'world' | 'other';

export const PRIMARY_GENRES: PrimaryGenre[] = [
  'pop','rock','hip_hop','rnb','electronic','jazz','classical',
  'country','folk','metal','blues','soul','reggae','latin',
  'alternative','soundtrack','world','other',
];

export interface ProjectMetadata {
  description?: string;
  tags?: string[];
  genre?: PrimaryGenre | '';
  songLanguage?: string;
  trackNumber?: number | null;
  trackCount?: number | null;
}

export interface UploadInfo {
  id: string;
  source?: string;
  fileName?: string;
  youtubeUrl?: string;
  cloudinaryUrl?: string;
  duration?: number;
  title?: string;
  spotifyTrackId?: string;
  artist?: string;
}

// ─── API Response types ──────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
}

export interface ApiSuccess<T = unknown> {
  [key: string]: T;
}

export interface UserPublic {
  id: string;
  accountName?: string;
  displayName?: string | null;
  email?: string;
  avatarUrl?: string | null;
  bio?: string;
  isVerified: boolean;
  ban: { active: boolean; reason?: string | null; until?: Date | null };
  appeal?: { text?: string | null; status: string; submittedAt?: Date | null; resolvedAt?: Date | null } | null;
  showUnbanMessage?: boolean;
  role: string;
  createdAt?: Date;
  passwordChangedAt?: Date | null;
  hasPassword?: boolean;
  spotify?: {
    connected: boolean;
    spotifyId?: string | null;
    isPremium: boolean;
    profilePictureUrl?: string | null;
  } | null;
  google?: {
    connected: boolean;
    googleId?: string | null;
    email?: string | null;
    name?: string | null;
    pictureUrl?: string | null;
  } | null;
  showFollowers?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse {
  user: UserPublic;
  accessToken: string;
  refreshToken: string;
}

export interface ProjectPublic {
  projectId: string;
  title?: string;
  upload?: UploadInfo | null;
  lyrics?: LyricsData;
  state?: ProjectState;
  metadata?: ProjectMetadata;
  type?: string;
  readOnly?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  version?: number;
}

export interface ProjectListItem {
  id: string;
  projectId: string;
  title?: string;
  metadata?: ProjectMetadata;
  upload?: UploadInfo | null;
  editorMode: string;
  lineCount: number;
  syncedLineCount: number;
  readOnly: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ServiceResult<T = unknown> {
  error?: string;
  code?: string;
  status?: number;
  [key: string]: T | undefined | string | number;
}

// ─── Mark / Editor action types ──────────────────────────────────────

export interface FocusedTimestamp {
  lineIndex: number;
  type: 'start' | 'end' | 'word';
  wordIndex?: number;
}

export interface EditorSettings {
  autoAdvance?: {
    enabled: boolean;
    skipBlank: boolean;
  };
  srt?: {
    snapToNextLine: boolean;
    minSubtitleGap: number;
  };
}

export interface MarkInput {
  lines: LineEntry[];
  activeLineIndex: number;
  time: number;
  editorMode: 'lrc' | 'srt' | 'words';
  activeWordIndex?: number;
  stampTarget?: 'main' | 'secondary';
  awaitingEndMark?: number | null;
  focusedTimestamp?: FocusedTimestamp | null;
  settings: EditorSettings;
}

export interface MarkResult {
  nextLines: LineEntry[];
  nextActiveLineIndex: number | null;
  nextAwaitingEndMark?: { lineIndex: number; mode: string } | null;
  nextActiveWordIndex?: number;
}

// ─── Admin types ─────────────────────────────────────────────────────

export interface AdminLogEntry {
  action: string;
  adminId: string;
  targetUserId?: string;
  targetUsername?: string;
  details?: string;
  ip?: string;
  createdAt?: Date;
}

// ─── Auth / Device types ─────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  username?: string;
  role?: string;
}