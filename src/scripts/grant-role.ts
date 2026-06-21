import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../db/user.model.js';
import { ROLE_PRESETS, isValidRole, ROLES } from '../shared/permissions.js';
import { logAdminAction } from '../modules/admin/admin.service.js';

/**
 * CLI: assign a role (and its preset permissions) to a user, by accountName or
 * email. The way to bootstrap the first superadmin, and a general tool for
 * granting admin/mod out-of-band. Gated by DB/shell access, not an in-app role.
 *
 * Usage:
 *   tsx src/scripts/grant-role.ts <accountName|email> <role>
 * Example:
 *   tsx src/scripts/grant-role.ts gburpy@gmail.com superadmin
 *
 * Roles: user | mod | admin | superadmin
 * Requires MONGODB_URI (loaded from .env).
 */

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [identifierRaw, roleRaw] = process.argv.slice(2);

  if (!identifierRaw || !roleRaw) {
    fail(`Usage: tsx src/scripts/grant-role.ts <accountName|email> <role>\n  roles: ${ROLES.join(' | ')}`);
  }

  const role = roleRaw.trim().toLowerCase();
  if (!isValidRole(role)) {
    fail(`Invalid role "${roleRaw}". Valid roles: ${ROLES.join(', ')}`);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) fail('MONGODB_URI is not set (expected in .env).');

  await mongoose.connect(uri);
  try {
    const identifier = identifierRaw.trim().toLowerCase();
    // Match on either field — both are stored lowercased.
    const user = await User.findOne({ $or: [{ accountName: identifier }, { email: identifier }] });
    if (!user) fail(`No user found with accountName or email "${identifierRaw}".`);

    const previousRole = user.role;
    const permissions = [...ROLE_PRESETS[role]];
    user.role = role;
    user.permissions = permissions;
    await user.save();

    logAdminAction({
      adminId: String(user._id),
      adminName: 'CLI',
      action: 'grant_role_cli',
      targetId: String(user._id),
      targetName: user.accountName ?? user.email ?? null,
      details: `${previousRole} → ${role}`,
    }).catch(() => {});

    console.log(`✓ ${user.accountName ?? user.email} : ${previousRole} → ${role}`);
    console.log(`  permissions: ${permissions.length ? permissions.join(', ') : '(none)'}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
