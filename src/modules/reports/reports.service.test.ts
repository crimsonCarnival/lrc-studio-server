import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import Block from '../blocks/block.model.js';
import { invalidateBlockCache } from '../blocks/block-list.cache.js';
import Notification from '../notifications/notification.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import ProjectFork from '../projects/project-fork.model.js';
import Playlist from '../playlists/playlist.model.js';
import AdminLog from '../admin/admin-log.model.js';
import { WallComment, WallCommentReport, WallRestriction } from '../wall/wall.models.js';
import { addComment } from '../wall/wall.service.js';
import { Report } from './report.model.js';
import {
  ReportError, fileReport, listMyReports, listReportGroups, openReportCount, resolveReportGroup,
} from './reports.service.js';
import { copyWallReports } from './migrate-wall-reports.js';
import { listWallReportGroups, resolveWallReport } from './reports.legacy.js';

// Deleting a project runs in a transaction, which needs a replica set.
let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Notification.init(), Report.init(), Project.init(), Lyrics.init(), ProjectFork.init(), User.init(), Playlist.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Block.deleteMany({}), Notification.deleteMany({}), UserPreferences.deleteMany({}),
    Project.deleteMany({}), Playlist.deleteMany({}), WallComment.deleteMany({}), WallCommentReport.deleteMany({}),
    WallRestriction.deleteMany({}), Report.deleteMany({}), AdminLog.deleteMany({}),
  ]);
});

async function mkUser(accountName: string, { permissions = [] as string[], role = 'user', isDeleted = false } = {}): Promise<string> {
  const res = await User.collection.insertOne({
    accountName, email: `${accountName}@x.test`, passwordHash: 'x', isDeleted, role, permissions, ban: { active: false },
  });
  return res.insertedId.toString();
}

async function mkProject(ownerId: string, title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; publicId: string }> {
  const publicId = `p${new mongoose.Types.ObjectId().toString().slice(-9)}`;
  const res = await Project.collection.insertOne({
    publicId, userId: new mongoose.Types.ObjectId(ownerId), title, slug: title.toLowerCase(), public: true,
    ownerActive: true, ownerListed: true, metadata: { songArtist: 'Band' }, ...extra,
  });
  return { id: res.insertedId.toString(), publicId };
}

async function mkPlaylist(ownerId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await Playlist.collection.insertOne({
    userId: new mongoose.Types.ObjectId(ownerId), name, isPublic: true, ownerActive: true, ownerListed: true, publicIds: [], tags: [], ...extra,
  });
  return res.insertedId.toString();
}

async function block(blocker: string, blocked: string): Promise<void> {
  await Block.collection.insertOne({ blockerId: new mongoose.Types.ObjectId(blocker), blockedId: new mongoose.Types.ObjectId(blocked) });
  invalidateBlockCache(blocker);
  invalidateBlockCache(blocked);
}

const codeOf = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (err) { return err instanceof ReportError ? err.code : `other: ${(err as Error).message}`; }
  return 'none';
};

// Notifications to moderators are sent after the mutation returns.
const settle = () => new Promise(r => setTimeout(r, 100));

describe('filing reports', () => {
  it('refuses unknown types and reasons that do not fit the type', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob');
    const p = await mkProject(b, 'Song');
    expect(await codeOf(() => fileReport(a, { targetType: 'nonsense', targetId: b, reason: 'spam' }))).toBe('invalid_body');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: p.id, reason: 'impersonation' }))).toBe('invalid_body');
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: b, reason: 'copyright' }))).toBe('invalid_body');
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: b, reason: 'impersonation' }))).toBe('none');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: p.id, reason: 'copyright' }))).toBe('none');
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: 'not-an-id', reason: 'spam' }))).toBe('not_found');
  });

  it('lets people report accounts they can see, never themselves', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat'), gone = await mkUser('gus', { isDeleted: true });
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: a, reason: 'spam' }))).toBe('forbidden');
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: gone, reason: 'spam' }))).toBe('not_found');
    // Blocked by them: their profile is hidden from the reporter.
    await block(b, a);
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: b, reason: 'spam' }))).toBe('not_found');
    // Blocking them yourself still leaves their name on the profile, so they can be reported.
    await block(a, c);
    expect(await codeOf(() => fileReport(a, { targetType: 'user', targetId: c, reason: 'harassment' }))).toBe('none');
  });

  it('lets people report projects they can see, never their own', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat');
    const mine = await mkProject(a, 'Mine');
    const hidden = await mkProject(b, 'Private', { public: false });
    const bannedOwner = await mkProject(b, 'Banned', { ownerActive: false });
    const blocked = await mkProject(c, 'Blocked');
    const ok = await mkProject(b, 'Public');
    await block(a, c);
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: mine.id, reason: 'spam' }))).toBe('forbidden');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: hidden.id, reason: 'spam' }))).toBe('not_found');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: bannedOwner.id, reason: 'spam' }))).toBe('not_found');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: blocked.id, reason: 'spam' }))).toBe('not_found');
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: ok.id, reason: 'spam' }))).toBe('none');
    // By publicId too, landing on the same report.
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: ok.publicId, reason: 'hate' }))).toBe('none');
    const reports = await Report.find({ targetType: 'project' }).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'hate', subjectUserId: new mongoose.Types.ObjectId(b), contextUserId: null });
  });

  it('lets people report playlists they can see, never their own', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob');
    const mine = await mkPlaylist(a, 'Mine');
    const hidden = await mkPlaylist(b, 'Private', { isPublic: false });
    const ok = await mkPlaylist(b, 'Public');
    expect(await codeOf(() => fileReport(a, { targetType: 'playlist', targetId: mine, reason: 'spam' }))).toBe('forbidden');
    expect(await codeOf(() => fileReport(a, { targetType: 'playlist', targetId: hidden, reason: 'spam' }))).toBe('not_found');
    expect(await codeOf(() => fileReport(a, { targetType: 'playlist', targetId: ok, reason: 'spam' }))).toBe('none');
  });

  it('lets people report wall comments they can see, never their own', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    const c = await addComment(a, 'sam', 'rude');
    expect(await codeOf(() => fileReport(a, { targetType: 'wall_comment', targetId: c.id, reason: 'spam' }))).toBe('forbidden');
    expect(await codeOf(() => fileReport(b, { targetType: 'wall_comment', targetId: c.id, reason: 'impersonation' }))).toBe('invalid_body');
    expect(await codeOf(() => fileReport(b, { targetType: 'wall_comment', targetId: c.id, reason: 'spam' }))).toBe('none');
    const report = await Report.findOne({ targetType: 'wall_comment' }).lean();
    expect(report).toMatchObject({ subjectUserId: new mongoose.Types.ObjectId(a), contextUserId: new mongoose.Types.ObjectId(owner) });
  });

  it('updates a repeat report, and tells moderators only about a new or reopened one', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });
    await settle();
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'hate', note: '<b>bad</b>' });
    await settle();
    let notes = await Notification.find({ userId: mod, type: 'report' }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actorCount: 1, meta: { targetType: 'project', targetLabel: 'Song' } });
    expect(await Report.findOne({}).lean()).toMatchObject({ reason: 'hate', note: 'bad', status: 'open' });

    await resolveReportGroup(mod, { targetType: 'project', targetId: p.id, action: 'dismiss' });
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });
    await settle();
    notes = await Notification.find({ userId: mod, type: 'report' }).lean();
    expect(notes[0].actorCount).toBe(2);
    expect(await Report.findOne({}).lean()).toMatchObject({ status: 'open', resolvedAt: null });
  });

  it('notifies moderators but never the reporter', async () => {
    const b = await mkUser('bob');
    const modA = await mkUser('mia', { permissions: ['users.ban'] }), modB = await mkUser('max', { permissions: ['users.ban'] });
    await mkUser('pat', { permissions: ['users.view'] });
    await fileReport(modA, { targetType: 'user', targetId: b, reason: 'spam' });
    await settle();
    expect(await Notification.countDocuments({ userId: modA, type: 'report' })).toBe(0);
    expect(await Notification.findOne({ userId: modB, type: 'report' }).lean()).toMatchObject({ meta: { targetType: 'user', targetLabel: 'bob' } });
    expect(await Notification.countDocuments({ type: 'report' })).toBe(1);
  });

  it('blocks a reported account when asked, and only accounts', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob');
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam', alsoBlock: true });
    expect(await Block.countDocuments({})).toBe(0);
    await fileReport(a, { targetType: 'user', targetId: b, reason: 'spam', alsoBlock: true });
    expect(await Block.countDocuments({ blockerId: a, blockedId: b })).toBe(1);
  });

  it('limits reports per reporter per hour across every type', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob');
    const p = await mkProject(b, 'Song');
    await Report.collection.insertMany(Array.from({ length: 20 }, () => ({
      targetType: 'user', targetId: new mongoose.Types.ObjectId(), reporterId: new mongoose.Types.ObjectId(a),
      reason: 'spam', note: '', status: 'open', createdAt: new Date(),
    })));
    expect(await codeOf(() => fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' }))).toBe('rate_limited');
  });
});

describe('the moderators queue', () => {
  it('groups reports per target, with a preview and the subject record', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const p = await mkProject(b, 'Song');
    const old = await mkProject(b, 'Old');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam', note: 'ads' });
    await fileReport(c, { targetType: 'project', targetId: p.id, reason: 'hate' });
    await fileReport(a, { targetType: 'user', targetId: c, reason: 'spam' });
    // Something of bob's was actioned recently, and he can't comment on walls.
    await fileReport(c, { targetType: 'project', targetId: old.id, reason: 'spam' });
    await Report.updateOne({ targetId: new mongoose.Types.ObjectId(old.id) }, { $set: { status: 'actioned', resolvedAt: new Date() } });
    await WallRestriction.collection.insertOne({ userId: new mongoose.Types.ObjectId(b), until: null, reason: '', createdBy: new mongoose.Types.ObjectId(mod) });

    expect(await codeOf(() => listReportGroups(a))).toBe('forbidden');
    const groups = await listReportGroups(mod);
    expect(groups).toHaveLength(2);
    const project = groups.find(g => g.targetType === 'project')!;
    expect(project).toMatchObject({
      targetId: p.id, openCount: 2,
      project: { publicId: p.publicId, title: 'Song', artist: 'Band', ownerAccountName: 'bob', public: true },
      user: null, comment: null, playlist: null,
      subject: { accountName: 'bob' }, subjectActionedCount: 1, subjectRestrictedUntil: 'forever',
    });
    expect(project.reports.map(r => [r.reporter?.accountName, r.reason, r.note])).toEqual([['ann', 'spam', 'ads'], ['cat', 'hate', '']]);

    const onlyUsers = await listReportGroups(mod, { targetType: 'user' });
    expect(onlyUsers).toHaveLength(1);
    expect(onlyUsers[0]).toMatchObject({ user: { accountName: 'cat', banned: false }, subject: { accountName: 'cat' } });
    expect(await listReportGroups(mod, { status: 'actioned' })).toHaveLength(1);
    expect(await codeOf(() => listReportGroups(mod, { targetType: 'bogus' }))).toBe('invalid_body');
  });

  it('counts targets with open reports, not reports', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat');
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });
    await fileReport(c, { targetType: 'project', targetId: p.id, reason: 'spam' });
    await fileReport(a, { targetType: 'user', targetId: c, reason: 'spam' });
    expect(await openReportCount()).toBe(2);
  });

  it('shows a reported comment with the comment it answers', async () => {
    await mkUser('sam');
    const a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const top = await addComment(b, 'sam', 'question');
    const reply = await addComment(a, 'sam', 'rude answer', top.id);
    await fileReport(b, { targetType: 'wall_comment', targetId: reply.id, reason: 'harassment' });
    const [group] = await listReportGroups(mod);
    expect(group).toMatchObject({
      wallAccountName: 'sam',
      comment: { comment: { id: reply.id, body: 'rude answer', author: { accountName: 'ann' } }, parent: { id: top.id }, wallAccountName: 'sam' },
      subject: { accountName: 'ann' },
    });
    // The wall-only queue still reads the same reports.
    const [legacy] = await listWallReportGroups(mod);
    expect(legacy).toMatchObject({ commentId: reply.id, wallAccountName: 'sam', comment: { id: reply.id }, parent: { id: top.id }, openCount: 1 });
  });
});

describe("a reporter's own reports", () => {
  it('lists only their own, without other reporters, and hides what they can no longer see', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat');
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });
    await fileReport(c, { targetType: 'project', targetId: p.id, reason: 'hate' });
    await fileReport(a, { targetType: 'user', targetId: b, reason: 'spam' });

    let mine = await listMyReports(a);
    expect(mine.total).toBe(2);
    expect(mine.reports.map(r => r.targetType)).toEqual(['user', 'project']);
    const project = mine.reports.find(r => r.targetType === 'project')!;
    expect(project).toMatchObject({ reason: 'spam', status: 'open', project: { title: 'Song' } });
    expect(Object.keys(project)).not.toContain('reports');
    expect(Object.keys(project)).not.toContain('openCount');
    expect(JSON.stringify(mine)).not.toContain('cat');

    await Project.updateOne({ _id: p.id }, { $set: { public: false } });
    mine = await listMyReports(a);
    expect(mine.reports.find(r => r.targetType === 'project')).toMatchObject({ project: null, targetId: p.id });
  });
});

describe('settling reports', () => {
  it('deletes a reported comment and tells each reporter', async () => {
    await mkUser('sam');
    const a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const comment = await addComment(a, 'sam', 'rude');
    await fileReport(b, { targetType: 'wall_comment', targetId: comment.id, reason: 'spam' });
    await fileReport(c, { targetType: 'wall_comment', targetId: comment.id, reason: 'hate' });

    expect(await codeOf(() => resolveReportGroup(b, { targetType: 'wall_comment', targetId: comment.id, action: 'action' }))).toBe('forbidden');
    await resolveReportGroup(mod, { targetType: 'wall_comment', targetId: comment.id, action: 'action' });
    await settle();
    expect(await WallComment.countDocuments({ _id: comment.id })).toBe(0);
    expect(await Report.countDocuments({ status: 'actioned' })).toBe(2);
    for (const reporter of [b, c]) {
      expect(await Notification.findOne({ userId: reporter, type: 'report_reviewed' }).lean())
        .toMatchObject({ meta: { outcome: 'actioned', targetType: 'wall_comment', targetLabel: 'rude', wall: 'sam' } });
    }
    expect(await AdminLog.findOne({ action: 'report_action' }).lean()).toMatchObject({ targetName: 'ann' });
    expect(await openReportCount()).toBe(0);
  });

  it('deletes a reported project only with sudo', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', { permissions: ['users.ban'], role: 'mod' });
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'copyright' });

    expect(await codeOf(() => resolveReportGroup(mod, { targetType: 'project', targetId: p.id, action: 'action' }))).toBe('sudo_required');
    expect(await Project.countDocuments({ _id: p.id })).toBe(1);
    expect(await Report.countDocuments({ status: 'open' })).toBe(1);

    await resolveReportGroup(mod, { targetType: 'project', targetId: p.id, action: 'action' }, { hasSudo: true });
    await settle();
    expect(await Project.countDocuments({ _id: p.id })).toBe(0);
    expect(await Report.findOne({}).lean()).toMatchObject({ status: 'actioned', resolvedBy: new mongoose.Types.ObjectId(mod) });
    expect(await Notification.findOne({ userId: a, type: 'report_reviewed' }).lean())
      .toMatchObject({ meta: { outcome: 'actioned', targetType: 'project', targetLabel: 'Song' } });
    // The owner's record keeps it.
    expect((await listReportGroups(mod, { status: 'actioned' }))[0]).toMatchObject({ project: null, subject: { accountName: 'bob' }, subjectActionedCount: 1 });
  });

  it('will not delete content of staff who outrank the moderator', async () => {
    const a = await mkUser('ann'), boss = await mkUser('ada', { role: 'admin' }), mod = await mkUser('mia', { permissions: ['users.ban'], role: 'mod' });
    const p = await mkProject(boss, 'Song');
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });
    expect(await codeOf(() => resolveReportGroup(mod, { targetType: 'project', targetId: p.id, action: 'action' }, { hasSudo: true }))).toBe('forbidden');
    expect(await Project.countDocuments({ _id: p.id })).toBe(1);
  });

  it('deletes a reported playlist only with sudo', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', { permissions: ['users.ban'], role: 'mod' });
    const pl = await mkPlaylist(b, 'Mix');
    await fileReport(a, { targetType: 'playlist', targetId: pl, reason: 'spam' });
    expect(await codeOf(() => resolveReportGroup(mod, { targetType: 'playlist', targetId: pl, action: 'action' }))).toBe('sudo_required');
    expect(await Playlist.countDocuments({ _id: pl })).toBe(1);
    await resolveReportGroup(mod, { targetType: 'playlist', targetId: pl, action: 'action' }, { hasSudo: true });
    expect(await Playlist.countDocuments({ _id: pl })).toBe(0);
    expect(await Report.countDocuments({ status: 'actioned' })).toBe(1);
  });

  it('leaves a reported account alone, and dismisses without touching anything', async () => {
    const a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const p = await mkProject(b, 'Song');
    await fileReport(a, { targetType: 'user', targetId: b, reason: 'harassment' });
    await fileReport(a, { targetType: 'project', targetId: p.id, reason: 'spam' });

    await resolveReportGroup(mod, { targetType: 'user', targetId: b, action: 'action' });
    await resolveReportGroup(mod, { targetType: 'project', targetId: p.id, action: 'dismiss' });
    await settle();
    expect(await User.findById(b).lean()).toMatchObject({ isDeleted: false, ban: { active: false } });
    expect(await Project.countDocuments({ _id: p.id })).toBe(1);
    expect(await Report.findOne({ targetType: 'user' }).lean()).toMatchObject({ status: 'actioned' });
    expect(await Report.findOne({ targetType: 'project' }).lean()).toMatchObject({ status: 'dismissed' });
    const outcomes = (await Notification.find({ userId: a, type: 'report_reviewed' }).lean()).map(n => n.meta?.outcome).sort();
    expect(outcomes).toEqual(['actioned', 'dismissed']);
    expect((await AdminLog.find({}).lean()).map(l => l.action).sort()).toEqual(['report_action', 'report_dismiss']);
    expect(await codeOf(() => resolveReportGroup(mod, { targetType: 'user', targetId: a, action: 'dismiss' }))).toBe('not_found');
    expect(await codeOf(() => resolveReportGroup(mod, { targetType: 'user', targetId: b, action: 'ban' }))).toBe('invalid_body');
  });

  it('settles a comment\'s reports when its author deletes it', async () => {
    await mkUser('sam');
    const a = await mkUser('ann'), b = await mkUser('bob');
    const comment = await addComment(a, 'sam', 'oops');
    await fileReport(b, { targetType: 'wall_comment', targetId: comment.id, reason: 'spam' });
    const { deleteComment } = await import('../wall/wall.service.js');
    await deleteComment(a, comment.id);
    expect(await Report.findOne({}).lean()).toMatchObject({ status: 'actioned' });
  });
});

describe('copying wall comment reports', () => {
  it('copies each row once, keeps its id, and never overwrites a newer report', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob'), c = await mkUser('cat'), mod = await mkUser('mia', { permissions: ['users.ban'] });
    const comment = await addComment(a, 'sam', 'rude');
    const commentId = new mongoose.Types.ObjectId(comment.id);
    const at = new Date('2026-01-02T03:04:05Z');
    const old = await WallCommentReport.collection.insertMany([
      { commentId, wallUserId: new mongoose.Types.ObjectId(owner), reporterId: new mongoose.Types.ObjectId(b), authorId: new mongoose.Types.ObjectId(a), reason: 'spam', note: 'n', status: 'dismissed', resolvedBy: new mongoose.Types.ObjectId(mod), resolvedAt: at, createdAt: at },
      { commentId, wallUserId: new mongoose.Types.ObjectId(owner), reporterId: new mongoose.Types.ObjectId(c), authorId: new mongoose.Types.ObjectId(a), reason: 'hate', note: '', status: 'open', resolvedBy: null, resolvedAt: null, createdAt: at },
    ]);
    // cat already reported it again through the new path.
    await fileReport(c, { targetType: 'wall_comment', targetId: comment.id, reason: 'harassment' });

    expect(await copyWallReports({ dryRun: true })).toEqual({ scanned: 2, inserted: 1, skipped: 1 });
    expect(await Report.countDocuments({})).toBe(1);
    expect(await copyWallReports()).toEqual({ scanned: 2, inserted: 1, skipped: 1 });
    expect(await copyWallReports()).toEqual({ scanned: 2, inserted: 0, skipped: 2 });

    const copied = await Report.findById(old.insertedIds[0]).lean();
    expect(copied).toMatchObject({
      targetType: 'wall_comment', targetId: commentId, reporterId: new mongoose.Types.ObjectId(b),
      subjectUserId: new mongoose.Types.ObjectId(a), contextUserId: new mongoose.Types.ObjectId(owner),
      reason: 'spam', note: 'n', status: 'dismissed', resolvedBy: new mongoose.Types.ObjectId(mod), resolvedAt: at, createdAt: at,
    });
    expect(await Report.findOne({ reporterId: c }).lean()).toMatchObject({ reason: 'harassment', status: 'open' });
    expect(await WallCommentReport.countDocuments({})).toBe(2);

    // An old client's report id still resolves.
    await resolveWallReport(mod, old.insertedIds[0].toString(), 'dismiss');
    expect(await Report.countDocuments({ status: 'open' })).toBe(0);
  });
});
