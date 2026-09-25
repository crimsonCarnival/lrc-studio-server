import type { ClientSession } from 'mongoose';
import User, { type IUser } from '../../db/user.model.js';
import { ROLE_PRESETS } from '../../shared/permissions.js';
import { logAdminAction } from '../admin/admin.service.js';
import { getEnv } from '../../config/env.js';

/**
 * Env-based superadmin bootstrap.
 *
 * `SUPERADMIN_EMAIL` is a GRANT-ONLY mechanism: if set, every user whose
 * email exactly (case-insensitively) matches one entry in the comma-separated
 * list is promoted to `superadmin` if not already. It intentionally does NOT
 * demote a current superadmin when the env var is unset, empty, or later
 * drops/changes an entry. Auto-demoting based on an env var is dangerous: a
 * misconfigured/rolled-back deploy could silently lock out (or hand over,
 * mid-incident) the real admin. Revocation stays a manual, explicit
 * operation via `scripts/grant-role.ts <email> admin` (or another role).
 *
 * This is triggered from two places, never from an HTTP route (the env var
 * is operator-controlled, not user input):
 *   1. Startup sync (`syncSuperadminEmailGrant`, wired in plugins/cron.ts)
 *      — covers users who already exist when the server boots.
 *   2. Immediately on successful registration/Google sign-up for a matching
 *      email (`grantSuperadminIfEnvMatch` called directly from
 *      auth.tx.service.ts#registerAtomically and google.service.ts) — covers
 *      a brand-new account that doesn't exist yet at startup, so it isn't
 *      left as a plain user until the next restart.
 */

/** Parses SUPERADMIN_EMAIL into a deduped set of trimmed, lowercased addresses. Empty entries (",,", trailing comma) are dropped. */
function normalizedSuperadminEmails(): Set<string> {
  const raw = getEnv().SUPERADMIN_EMAIL;
  if (!raw) return new Set();
  const emails = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return new Set(emails);
}

/** True iff `email` case-insensitively equals one entry in the configured SUPERADMIN_EMAIL list. No-op (false) when unset/empty. */
export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return normalizedSuperadminEmails().has(email.trim().toLowerCase());
}

/**
 * Grants superadmin to `user` if their email matches SUPERADMIN_EMAIL and
 * they don't already hold the role. Idempotent: returns `false` and does
 * nothing (no save, no audit log entry) if the role wouldn't change, so
 * calling this repeatedly (every startup, every login) never duplicates logs.
 *
 * Never demotes — only ever moves a matching user's role *up* to superadmin.
 *
 * Mutates and saves the passed-in document in place so callers that already
 * hold a reference (e.g. mid-transaction during registration) see the
 * updated role/permissions immediately, before any JWT is signed from it.
 */
export async function grantSuperadminIfEnvMatch(user: IUser, session?: ClientSession): Promise<boolean> {
  if (!isSuperadminEmail(user.email)) return false;
  if (user.role === 'superadmin') return false;

  const previousRole = user.role;
  user.role = 'superadmin';
  // superadmin's preset is fixed at `[...PERMISSIONS]` and is NOT
  // DB-overridable (see admin.service.ts EDITABLE_ROLES / getEffectiveRolePresets
  // — 'superadmin' is never looked up in RolePermissionsConfig), so the code
  // constant is always the correct, full set here — no need to pay for the
  // extra DB read that getEffectiveRolePresets() would incur.
  user.permissions = [...ROLE_PRESETS.superadmin];
  await user.save(session ? { session } : undefined);

  // Actor is the environment/operator, not another user — mirrors the CLI
  // bootstrap script's pattern (grant-role.ts) of attributing the log entry
  // to the target's own id with a descriptive synthetic admin name.
  await logAdminAction({
    adminId: String(user._id),
    adminName: 'system:SUPERADMIN_EMAIL',
    action: 'grant_superadmin_env',
    targetId: String(user._id),
    targetName: user.accountName ?? user.email ?? null,
    details: `${previousRole} -> superadmin (env-matched SUPERADMIN_EMAIL)`,
  }).catch(() => {});

  return true;
}

/**
 * Startup job: idempotently promotes every existing user whose email matches
 * an entry in SUPERADMIN_EMAIL. No-op if the env var is unset/empty. A listed
 * email with no matching user yet is fine — a later registration/Google
 * sign-up with that email is caught by `grantSuperadminIfEnvMatch` directly.
 */
export async function syncSuperadminEmailGrant(): Promise<void> {
  const targets = normalizedSuperadminEmails();
  if (targets.size === 0) return;

  const users = await User.find({ email: { $in: [...targets] } });
  for (const user of users) {
    await grantSuperadminIfEnvMatch(user);
  }
}
