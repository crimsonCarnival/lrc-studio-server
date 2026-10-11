/**
 * Owner-visibility: the denormalized flags that keep a deactivated, banned or
 * shadow-banned user's content off the surfaces where their profile is already
 * hidden.
 *
 * Two properties matter most and are easy to break:
 *   1. The flags are DERIVED. Every sync recomputes from the user document, so
 *      composing transitions (unban a user who is also shadow-banned) must not
 *      resurface content.
 *   2. `ownerActive` and `ownerListed` are NOT interchangeable. A shadow ban
 *      must remove content from lists while leaving direct links working, or
 *      the shadow ban is detectable by its target.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  notifyUnban: async () => undefined,
  notifyRoleChanged: async () => undefined,
  notifyXpChanged: async () => undefined,
  upsertSocial: async () => undefined,
  upsertFollow: async () => undefined,
}));
vi.mock('../email/email.service.js', () => ({ sendBanEmail: async () => undefined }));

import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import Playlist from '../../db/playlist.model.js';
import AdminLog from '../admin/adminLog.model.js';
import {
  computeOwnerVisibility,
  isOwnerActive,
  isOwnerListed,
  syncOwnerVisibility,
  visibilityForNewContent,
} from './owner-visibility.service.js';
import { toggleBan, toggleShadowBan, reactivateUser } from '../admin/admin.service.js';
import { deactivateUser } from '../auth/auth.service.js';

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
    User.deleteMany({}), Project.deleteMany({}), Playlist.deleteMany({}), AdminLog.deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(opts: {
  role?: string;
  banned?: boolean;
  banUntil?: Date | null;
  deleted?: boolean;
  shadowSearch?: boolean;
  shadowFeed?: boolean;
} = {}): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `own${n}`,
    email: `own${n}@x.test`,
    passwordHash: 'x',
    isDeleted: !!opts.deleted,
    deletedAt: opts.deleted ? new Date() : null,
    role: opts.role ?? 'user',
    permissions: [],
    ban: { active: !!opts.banned, reason: opts.banned ? 'spam' : null, until: opts.banUntil ?? null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
    shadowBan: {
      feed: !!opts.shadowFeed, search: !!opts.shadowSearch,
      reason: null, appliedAt: null, appliedBy: null,
    },
  });
  return res.insertedId.toString();
}

let pid = 0;
async function mkProject(userId: string): Promise<string> {
  pid++;
  const doc = await Project.create({
    publicId: `own-proj-${pid}`,
    userId: new mongoose.Types.ObjectId(userId),
    title: 'Song',
    public: true,
  });
  return doc.publicId;
}

async function mkPlaylist(userId: string): Promise<mongoose.Types.ObjectId> {
  const doc = await Playlist.create({ userId: new mongoose.Types.ObjectId(userId), name: 'List', isPublic: true });
  return doc._id;
}

type Flags = { ownerActive?: boolean; ownerListed?: boolean };
const projFlags = (publicId: string) => Project.findOne({ publicId }).lean<Flags>();
const listFlags = (id: mongoose.Types.ObjectId) => Playlist.findById(id).lean<Flags>();

describe('computeOwnerVisibility', () => {
  it('a clean owner is active and listed', () => {
    expect(computeOwnerVisibility({})).toEqual({ ownerActive: true, ownerListed: true });
  });

  it('a deactivated owner is neither', () => {
    expect(computeOwnerVisibility({ isDeleted: true })).toEqual({ ownerActive: false, ownerListed: false });
  });

  it('a banned owner is neither', () => {
    expect(computeOwnerVisibility({ ban: { active: true } })).toEqual({ ownerActive: false, ownerListed: false });
  });

  it('a search-shadow-banned owner stays ACTIVE but is unlisted', () => {
    // The whole point: links keep working, lists do not show them.
    expect(computeOwnerVisibility({ shadowBan: { search: true } }))
      .toEqual({ ownerActive: true, ownerListed: false });
  });

  it('a feed-only shadow ban touches neither flag — it filters the feed, not content', () => {
    expect(computeOwnerVisibility({ shadowBan: { search: false } }))
      .toEqual({ ownerActive: true, ownerListed: true });
  });

  it('a missing owner is treated as hidden, never as visible', () => {
    expect(computeOwnerVisibility(null)).toEqual({ ownerActive: false, ownerListed: false });
    expect(computeOwnerVisibility(undefined)).toEqual({ ownerActive: false, ownerListed: false });
  });

  it('an expired-but-still-flagged ban is hidden — only checkBanStatus clears it', () => {
    expect(isOwnerActive({ ban: { active: true } })).toBe(false);
  });

  it('isOwnerListed implies isOwnerActive for every state', () => {
    const states = [
      {}, { isDeleted: true }, { ban: { active: true } },
      { shadowBan: { search: true } }, { isDeleted: true, shadowBan: { search: true } },
    ];
    for (const s of states) {
      if (isOwnerListed(s)) expect(isOwnerActive(s)).toBe(true);
    }
  });
});

describe('syncOwnerVisibility', () => {
  it('hides every project and playlist a deactivated owner has', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    const l = await mkPlaylist(u);

    await User.updateOne({ _id: u }, { $set: { isDeleted: true } });
    await syncOwnerVisibility(u);

    expect(await projFlags(p)).toMatchObject({ ownerActive: false, ownerListed: false });
    expect(await listFlags(l)).toMatchObject({ ownerActive: false, ownerListed: false });
  });

  it('unlists but does not deactivate a shadow-banned owner\'s content', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    await User.updateOne({ _id: u }, { $set: { 'shadowBan.search': true } });
    await syncOwnerVisibility(u);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: false });
  });

  it('restores content when the owner becomes visible again', async () => {
    const u = await mkUser({ deleted: true });
    const p = await mkProject(u);
    await syncOwnerVisibility(u);
    expect((await projFlags(p))?.ownerActive).toBe(false);

    await User.updateOne({ _id: u }, { $set: { isDeleted: false, deletedAt: null } });
    await syncOwnerVisibility(u);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: true });
  });

  it('recomputes from scratch — lifting a ban on a shadow-banned owner does not relist', async () => {
    // The failure mode a toggle-based implementation would have.
    const u = await mkUser({ banned: true, shadowSearch: true });
    const p = await mkProject(u);
    await syncOwnerVisibility(u);

    await User.updateOne({ _id: u }, { $set: { 'ban.active': false } });
    await syncOwnerVisibility(u);

    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: false });
  });

  it('is idempotent', async () => {
    const u = await mkUser({ banned: true });
    const p = await mkProject(u);
    await syncOwnerVisibility(u);
    await syncOwnerVisibility(u);
    await syncOwnerVisibility(u);
    expect(await projFlags(p)).toMatchObject({ ownerActive: false, ownerListed: false });
  });

  it('touches only the given owner\'s content', async () => {
    const victim = await mkUser({ banned: true });
    const bystander = await mkUser();
    const vp = await mkProject(victim);
    const bp = await mkProject(bystander);

    await syncOwnerVisibility(victim);
    expect((await projFlags(vp))?.ownerActive).toBe(false);
    expect((await projFlags(bp))?.ownerActive).toBe(true);
  });

  it('returns null for an owner that no longer exists', async () => {
    expect(await syncOwnerVisibility(new mongoose.Types.ObjectId().toString())).toBeNull();
  });
});

describe('visibilityForNewContent', () => {
  it('a shadow-banned owner\'s new content is unlisted from the moment it exists', async () => {
    const u = await mkUser({ shadowSearch: true });
    expect(await visibilityForNewContent(u)).toEqual({ ownerActive: true, ownerListed: false });
  });

  it('a clean owner\'s new content is visible', async () => {
    const u = await mkUser();
    expect(await visibilityForNewContent(u)).toEqual({ ownerActive: true, ownerListed: true });
  });

  it('guest content with no owner is visible — its own `public` flag decides', async () => {
    expect(await visibilityForNewContent(null)).toEqual({ ownerActive: true, ownerListed: true });
    expect(await visibilityForNewContent(undefined)).toEqual({ ownerActive: true, ownerListed: true });
  });
});

describe('wired into the moderation transitions', () => {
  it('deactivateUser takes the user\'s content down with it', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    const l = await mkPlaylist(u);

    const res = await deactivateUser(u);
    expect(res.error).toBeUndefined();
    expect(await projFlags(p)).toMatchObject({ ownerActive: false, ownerListed: false });
    expect(await listFlags(l)).toMatchObject({ ownerActive: false, ownerListed: false });
  });

  it('reactivateUser brings it back', async () => {
    const admin = await mkUser({ role: 'superadmin' });
    const u = await mkUser();
    const p = await mkProject(u);

    await deactivateUser(u);
    await reactivateUser(u, admin);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: true });
  });

  it('toggleBan hides content, unban restores it', async () => {
    const admin = await mkUser({ role: 'superadmin' });
    const u = await mkUser();
    const p = await mkProject(u);

    await toggleBan(u, true, 'spam', null, false, false, admin);
    expect((await projFlags(p))?.ownerActive).toBe(false);

    await toggleBan(u, false, null, null, false, false, admin);
    expect((await projFlags(p))?.ownerActive).toBe(true);
  });

  it('a refused ban leaves content alone', async () => {
    const mod = await mkUser({ role: 'mod' });
    const target = await mkUser({ role: 'admin' });
    const p = await mkProject(target);

    const res = await toggleBan(target, true, 'nope', null, false, false, mod);
    expect(res.status).toBe(403);
    expect((await projFlags(p))?.ownerActive).toBe(true);
  });

  it('toggleShadowBan(search) unlists content without deactivating it', async () => {
    const admin = await mkUser({ role: 'superadmin' });
    const u = await mkUser();
    const p = await mkProject(u);

    await toggleShadowBan(u, false, true, 'brigading', admin);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: false });

    await toggleShadowBan(u, false, false, null, admin);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: true });
  });

  it('a feed-only shadow ban leaves content fully visible', async () => {
    const admin = await mkUser({ role: 'superadmin' });
    const u = await mkUser();
    const p = await mkProject(u);
    await toggleShadowBan(u, true, false, 'feed only', admin);
    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: true });
  });

  it('an expiring temporary ban restores content with no admin action', async () => {
    // checkBanStatus runs on every authenticated request and is the only place
    // a lapsed ban is cleared, so it is the only place that can un-hide the
    // content again.
    const admin = await mkUser({ role: 'superadmin' });
    const u = await mkUser();
    const p = await mkProject(u);

    await toggleBan(u, true, 'cooling off', new Date(Date.now() + 50).toISOString(), false, false, admin);
    expect((await projFlags(p))?.ownerActive).toBe(false);

    await new Promise((r) => setTimeout(r, 80));
    const doc = await User.findById(u);
    expect(await doc!.checkBanStatus()).toBe(true);

    expect(await projFlags(p)).toMatchObject({ ownerActive: true, ownerListed: true });
  });
});
