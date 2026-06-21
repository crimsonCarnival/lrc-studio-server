// Central authority model.
//
// Permissions are the ONLY thing checked for authorization. A user's `role`
// is purely descriptive (display + staff-protection ranking); it never grants
// access on its own. Assigning a role seeds the user's `permissions` array
// from ROLE_PRESETS, after which permissions can be tuned per-user independently.

export const PERMISSIONS = [
  'users.view',     // list/inspect users, view banned IP/device lists
  'users.ban',      // ban / unban / reject appeal / reactivate
  'users.delete',   // hard-delete a user
  'users.role',     // assign roles / edit another user's permissions
  'network.block',  // block / unblock IPs and devices
  'audit.view',     // read audit logs
  'stats.view',     // read admin stats dashboards
  'badges.manage',  // create/update/delete badge defs, grant/revoke, retroactive scan
  'levels.manage',  // create/update/delete addiction levels
  'xp.adjust',      // manually adjust user XP
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Superadmin holds this wildcard instead of an enumerated list, so any
// permission added later is automatically covered — no risk of forgetting to
// extend the superadmin preset.
export const WILDCARD = '*';

export const ROLES = ['user', 'mod', 'admin', 'superadmin'] as const;
export type Role = (typeof ROLES)[number];

// Higher rank = more authority. Used ONLY for staff-protection checks
// (you cannot act on, or promote to, a rank >= your own). Not used for
// permission resolution.
export const ROLE_RANK: Record<Role, number> = {
  user: 0,
  mod: 1,
  admin: 2,
  superadmin: 3,
};

// Mods: read + user moderation only. No network blocking (admin handles that),
// no content management. Mods raise requests to admins out-of-band.
const MOD_PERMS: Permission[] = ['users.view', 'users.ban', 'audit.view', 'stats.view'];
// Admins: mod powers + IP/device blocking + assigning roles below their own
// (i.e. setting up mods). NOT XP/badges/levels — those are superadmin-only;
// admins raise proposals to superadmins for them.
const ADMIN_PERMS: Permission[] = [...MOD_PERMS, 'network.block', 'users.role'];

// Default permission set granted when a role is assigned.
export const ROLE_PRESETS: Record<Role, string[]> = {
  user: [],
  mod: MOD_PERMS,
  admin: ADMIN_PERMS,
  superadmin: [WILDCARD],
};

// Authoritative check. A wildcard holder passes every permission.
export function hasPermission(permissions: string[] | undefined | null, required: Permission): boolean {
  if (!permissions || permissions.length === 0) return false;
  return permissions.includes(WILDCARD) || permissions.includes(required);
}

export function isValidRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function rankOf(role: string | undefined | null): number {
  return role && isValidRole(role) ? ROLE_RANK[role] : 0;
}
