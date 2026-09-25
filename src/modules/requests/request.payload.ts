import type { RequestType } from './request.model.js';
import { MAX_XP_GRANT } from '../admin/admin.service.js';

// Whitelisting validators for staff-request payloads. The direct admin paths are
// guarded by GraphQL input types / Fastify JSON schemas; a request payload is
// free-form JSON, so it is rebuilt here field by field (unknown keys dropped)
// both when it is submitted and again when it is approved. This is what stops
// a proposal from smuggling fields like `isBuiltin` / `createdBy` into `$set`.

export type Payload = Record<string, unknown>;

/** Max length of the JSON-encoded payload accepted from the client. */
export const MAX_PAYLOAD_CHARS = 8_000;
export const MAX_NOTE_CHARS = 500;
const MAX_XP_USER_IDS = 100;

const SLUG = /^[a-z0-9_-]+$/;
const BADGE_COLORS = ['amber', 'teal', 'green', 'primary', 'rose', 'shimmer', 'blue', 'orange'];
const BADGE_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const CONDITION_TYPES = [
  'registration_rank', 'minutes_synced', 'words_synced', 'karaoke_lines', 'project_count',
  'public_project_count', 'stars_received', 'forks_received', 'follower_count', 'upload_count',
  'account_age_days', 'streak_days', 'is_verified', 'role_admin', 'manual',
];
const REQUIREMENT_KEYS = [
  'syncedLines', 'karaokeLines', 'musicSyncedMinutes', 'publicProjects',
  'starsReceived', 'wordsTimestamped', 'totalProjects',
] as const;

export class PayloadError extends Error {
  status = 400;
}

const fail = (msg: string): never => { throw new PayloadError(`Invalid payload: ${msg}`); };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, max: number, { required = false, min = 0 } = {}): string | undefined {
  if (v === undefined || v === null) return required ? fail(`${field} is required`) : undefined;
  if (typeof v !== 'string') return fail(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max) return fail(`${field} length must be ${min}-${max}`);
  return s;
}

function int(v: unknown, field: string, { min = -Infinity, max = Infinity } = {}): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return fail(`${field} must be an integer in range`);
  return v;
}

function oneOf(v: unknown, field: string, allowed: string[], required = false): string | undefined {
  if (v === undefined || v === null) return required ? fail(`${field} is required`) : undefined;
  if (typeof v !== 'string' || !allowed.includes(v)) return fail(`${field} is not allowed`);
  return v;
}

function slug(v: unknown, field: string, max: number): string {
  const s = str(v, field, max, { required: true, min: 1 }) as string;
  if (!SLUG.test(s.toLowerCase())) fail(`${field} must match ${SLUG}`);
  return s.toLowerCase();
}

function localized(v: unknown, field: string, max: number, required: boolean): { en: string; es?: string } | undefined {
  if (v === undefined || v === null) return required ? fail(`${field} is required`) : undefined;
  if (!isObj(v)) return fail(`${field} must be an object`);
  const en = str(v.en, `${field}.en`, max, { required: true, min: required ? 1 : 0 }) as string;
  const es = str(v.es, `${field}.es`, max);
  return es === undefined ? { en } : { en, es };
}

/** Drops undefined keys so `$set` never receives them. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// Mirrors GraphQL `BadgeDefInput` (label/color/conditionType non-null) plus the
// BadgeDefinition model's enums and length limits.
function badgeInput(v: unknown, withId: boolean): Payload {
  if (!isObj(v)) return fail('input must be an object');
  const conditionValue = v.conditionValue === null ? null : int(v.conditionValue, 'conditionValue', { min: 0 });
  if (v.autoGrant !== undefined && typeof v.autoGrant !== 'boolean') fail('autoGrant must be a boolean');
  return compact({
    id: withId && v.id !== undefined ? slug(v.id, 'id', 40) : undefined,
    label: localized(v.label, 'label', 50, true),
    description: localized(v.description, 'description', 200, false),
    icon: str(v.icon, 'icon', 10),
    color: oneOf(v.color, 'color', BADGE_COLORS, true),
    rarity: oneOf(v.rarity, 'rarity', BADGE_RARITIES),
    conditionType: oneOf(v.conditionType, 'conditionType', CONDITION_TYPES, true),
    conditionValue,
    autoGrant: v.autoGrant as boolean | undefined,
    xpReward: int(v.xpReward, 'xpReward', { min: 0, max: MAX_XP_GRANT }),
  });
}

// Mirrors GraphQL `AddictionLevelInput` / `AddictionLevelUpdateInput`.
function levelInput(v: unknown, create: boolean): Payload {
  if (!isObj(v)) return fail('input must be an object');
  let requirements: Record<string, number> | undefined;
  if (v.requirements !== undefined && v.requirements !== null) {
    if (!isObj(v.requirements)) fail('requirements must be an object');
    const r = v.requirements as Record<string, unknown>;
    requirements = compact(Object.fromEntries(
      REQUIREMENT_KEYS.map(k => [k, int(r[k], `requirements.${k}`, { min: 0 })])
    )) as Record<string, number>;
  }
  return compact({
    id: create ? slug(v.id, 'id', 40) : undefined,
    title: localized(v.title, 'title', 60, create),
    description: localized(v.description, 'description', 200, false),
    requirements,
    order: int(v.order, 'order', { min: -1_000_000, max: 1_000_000 }),
  });
}

/**
 * Validates and whitelists a request payload for `type`. Returns a fresh object
 * containing only the allowed fields; throws PayloadError (status 400) otherwise.
 */
export function sanitizePayload(type: RequestType, raw: unknown): Payload {
  if (!isObj(raw)) return fail('payload must be an object');
  switch (type) {
    case 'badge_create':
      return { input: badgeInput(raw.input, true) };
    case 'badge_update':
      // Renaming a badge id is not proposable; `id` identifies the target only.
      return { id: slug(raw.id, 'id', 40), input: badgeInput(raw.input, false) };
    case 'badge_delete':
    case 'level_delete':
      return { id: slug(raw.id, 'id', 40) };
    case 'level_create':
      return { input: levelInput(raw.input, true) };
    case 'level_update':
      return { id: slug(raw.id, 'id', 40), input: levelInput(raw.input, false) };
    case 'block_ip':
      // Mirrors admin.schema.ts blockIpSchema.
      return compact({ ip: str(raw.ip, 'ip', 45, { required: true, min: 7 }), reason: str(raw.reason, 'reason', 500) });
    case 'block_device':
      // Mirrors admin.schema.ts blockDeviceSchema.
      return compact({ deviceId: str(raw.deviceId, 'deviceId', 128, { required: true, min: 1 }), reason: str(raw.reason, 'reason', 500) });
    case 'xp_adjust': {
      // Mirrors admin.controller.ts adjustXP body checks.
      const action = oneOf(raw.action, 'action', ['grant', 'revoke'], true);
      const target = oneOf(raw.target, 'target', ['all', 'user', 'users'], true);
      if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0 || raw.amount > MAX_XP_GRANT) {
        fail(`amount must be in 1-${MAX_XP_GRANT}`);
      }
      const userId = target === 'user' ? str(raw.userId, 'userId', 64, { required: true, min: 1 }) : undefined;
      let userIds: string[] | undefined;
      if (target === 'users') {
        if (!Array.isArray(raw.userIds) || raw.userIds.length === 0 || raw.userIds.length > MAX_XP_USER_IDS) {
          fail(`userIds must have 1-${MAX_XP_USER_IDS} entries`);
        }
        userIds = (raw.userIds as unknown[]).map((u, i) => str(u, `userIds[${i}]`, 64, { required: true, min: 1 }) as string);
      }
      return compact({ action, amount: raw.amount as number, target, userId, userIds });
    }
  }
}
