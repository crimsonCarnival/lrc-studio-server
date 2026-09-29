import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../../db/user.model.js';
import AdminLog from './adminLog.model.js';
import RolePermissionsConfig from './rolePermissionsConfig.model.js';
import { ROLE_PRESETS } from '../../shared/permissions.js';
import {
  getEffectiveRolePresets,
  updateRolePreset,
  updateUserPermissions,
  changeUserRole,
  syncRolePermissions,
} from './admin.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    AdminLog.deleteMany({}),
    RolePermissionsConfig.deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(role: string, permissions: string[] = []): Promise<{ id: string; role: string }> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `u${n}`, email: `u${n}@x.test`, passwordHash: 'x', isDeleted: false, role, permissions,
    ban: { active: false },
  });
  return { id: res.insertedId.toString(), role };
}

describe('getEffectiveRolePresets', () => {
  it('falls back to the code-defined ROLE_PRESETS when no DB override exists', async () => {
    const presets = await getEffectiveRolePresets();
    expect(presets.mod).toEqual(ROLE_PRESETS.mod);
    expect(presets.admin).toEqual(ROLE_PRESETS.admin);
    expect(presets.superadmin).toEqual(ROLE_PRESETS.superadmin);
    expect(presets.user).toEqual([]);
  });

  it('uses the DB override for an edited role and the code default for the other', async () => {
    const superadmin = await mkUser('superadmin');
    await updateRolePreset('mod', ['users.view'], superadmin.id);
    const presets = await getEffectiveRolePresets();
    expect(presets.mod).toEqual(['users.view']);
    expect(presets.admin).toEqual(ROLE_PRESETS.admin); // untouched role still falls back to code default
  });
});

describe('updateRolePreset — superadmin-only mutation', () => {
  it('rejects a non-superadmin actor even if they hold users.role', async () => {
    const admin = await mkUser('admin', ['users.role']);
    const result = await updateRolePreset('mod', ['users.view'], admin.id);
    expect(result).toMatchObject({ status: 403 });
    expect(await AdminLog.countDocuments()).toBe(0);
  });

  it('rejects a mod actor', async () => {
    const mod = await mkUser('mod', ['users.view']);
    const result = await updateRolePreset('mod', ['users.view'], mod.id);
    expect(result).toMatchObject({ status: 403 });
  });

  it('rejects unknown permission strings (whitelist)', async () => {
    const superadmin = await mkUser('superadmin');
    const result = await updateRolePreset('mod', ['users.view', 'totally.made.up'], superadmin.id);
    expect(result).toMatchObject({ status: 400 });
    const presets = await getEffectiveRolePresets();
    expect(presets.mod).toEqual(ROLE_PRESETS.mod); // unchanged
  });

  it('rejects editing the user or superadmin preset', async () => {
    const superadmin = await mkUser('superadmin');
    expect(await updateRolePreset('user', [], superadmin.id)).toMatchObject({ status: 400 });
    expect(await updateRolePreset('superadmin', ['users.view'], superadmin.id)).toMatchObject({ status: 400 });
  });

  it('accepts a valid edit from a real superadmin and writes an audit log with before/after', async () => {
    const superadmin = await mkUser('superadmin');
    const result = await updateRolePreset('admin', ['users.view', 'users.ban'], superadmin.id, '1.2.3.4');
    expect(result.success).toBe(true);

    const log = await AdminLog.findOne({ action: 'update_role_preset' }).lean();
    expect(log).toMatchObject({ targetName: 'admin', ip: '1.2.3.4' });
    expect(log?.details).toContain('users.view');
    expect(log?.details).toContain('Before:');
    expect(log?.details).toContain('After:');
  });

  it('deduplicates permissions before storing', async () => {
    const superadmin = await mkUser('superadmin');
    await updateRolePreset('mod', ['users.view', 'users.view', 'users.ban'], superadmin.id);
    const presets = await getEffectiveRolePresets();
    expect(presets.mod).toEqual(['users.view', 'users.ban']);
  });
});

describe('updateUserPermissions — superadmin-only mutation', () => {
  it('rejects a non-superadmin actor', async () => {
    const admin = await mkUser('admin', ['users.role']);
    const target = await mkUser('mod', ['users.view']);
    const result = await updateUserPermissions(target.id, ['users.view', 'users.ban'], admin.id);
    expect(result).toMatchObject({ status: 403 });
  });

  it('rejects unknown permission strings', async () => {
    const superadmin = await mkUser('superadmin');
    const target = await mkUser('mod', []);
    const result = await updateUserPermissions(target.id, ['not.a.real.permission'], superadmin.id);
    expect(result).toMatchObject({ status: 400 });
  });

  it('rejects acting on a superadmin target (rank check) — closes the escalation surface', async () => {
    const superadmin = await mkUser('superadmin');
    const otherSuperadmin = await mkUser('superadmin');
    const result = await updateUserPermissions(otherSuperadmin.id, [], superadmin.id);
    expect(result).toMatchObject({ status: 403 });
  });

  it('rejects self-edit (self has equal rank to actor)', async () => {
    const superadmin = await mkUser('superadmin');
    const result = await updateUserPermissions(superadmin.id, [], superadmin.id);
    expect(result).toMatchObject({ status: 403 });
  });

  it('grants and revokes individual permissions for a mod/admin target, and logs before/after', async () => {
    const superadmin = await mkUser('superadmin');
    const target = await mkUser('mod', ['users.view']);

    const result = await updateUserPermissions(target.id, ['users.view', 'audit.view'], superadmin.id, '9.9.9.9');
    expect(result.success).toBe(true);

    const updated = await User.findById(target.id).lean();
    expect(updated?.permissions).toEqual(['users.view', 'audit.view']);

    const log = await AdminLog.findOne({ action: 'update_user_permissions' }).lean();
    expect(log).toMatchObject({ targetId: new mongoose.Types.ObjectId(target.id), ip: '9.9.9.9' });
    expect(log?.details).toContain('Before: [users.view]');
    expect(log?.details).toContain('After: [users.view, audit.view]');
  });

  it('never touches role or rank — only the permissions array', async () => {
    const superadmin = await mkUser('superadmin');
    const target = await mkUser('mod', []);
    await updateUserPermissions(target.id, [...ROLE_PRESETS.superadmin], superadmin.id);
    const updated = await User.findById(target.id).lean();
    // Granting the full permission list does not change the role/rank field.
    expect(updated?.role).toBe('mod');
  });
});

describe('changeUserRole uses the effective (DB-override-aware) preset', () => {
  it('reseeds permissions from the admin-edited preset, not the raw code constant', async () => {
    const superadmin = await mkUser('superadmin');
    await updateRolePreset('mod', ['users.view', 'stats.view'], superadmin.id);

    const target = await mkUser('user', []);
    const result = await changeUserRole(target.id, 'mod', superadmin.id);
    expect(result.success).toBe(true);

    const updated = await User.findById(target.id).lean();
    expect(updated?.permissions).toEqual(['users.view', 'stats.view']);
  });
});

describe('syncRolePermissions backfills the effective preset', () => {
  it('adds the DB-overridden permission to existing users of that role without removing custom extras', async () => {
    const superadmin = await mkUser('superadmin');
    await updateRolePreset('mod', ['users.view', 'audit.view'], superadmin.id);

    const modUser = await mkUser('mod', ['users.view', 'custom.leftover']);
    await syncRolePermissions();

    const updated = await User.findById(modUser.id).lean();
    expect(updated?.permissions).toEqual(expect.arrayContaining(['users.view', 'audit.view', 'custom.leftover']));
  });
});
