import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import Notification from '../notifications/notification.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { Report } from './report.model.js';
import { ReportMessage } from './report-message.model.js';
import { ReportError } from './reports.service.js';
import { addReportMessage, listReportMessages, messageCounts } from './report-thread.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Notification.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Notification.deleteMany({}), UserPreferences.deleteMany({}),
    Report.deleteMany({}), ReportMessage.deleteMany({}),
  ]);
});

async function mkUser(accountName: string, permissions: string[] = []): Promise<string> {
  const res = await User.collection.insertOne({
    accountName, email: `${accountName}@x.test`, passwordHash: 'x', isDeleted: false,
    role: permissions.length ? 'mod' : 'user', permissions, ban: { active: false },
  });
  return res.insertedId.toString();
}

async function mkReport(reporterId: string): Promise<string> {
  const res = await Report.collection.insertOne({
    targetType: 'user', targetId: new mongoose.Types.ObjectId(), subjectUserId: null, contextUserId: null,
    reporterId: new mongoose.Types.ObjectId(reporterId), reason: 'spam', note: '', status: 'open',
    resolvedBy: null, resolvedAt: null, createdAt: new Date(),
  });
  return res.insertedId.toString();
}

const codeOf = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (err) { return err instanceof ReportError ? err.code : `other: ${(err as Error).message}`; }
  return 'none';
};

/** Notifications are sent in the background; wait for them to land. */
async function notes(userId: string, expected: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const n = await Notification.countDocuments({ userId, type: 'report_message' });
    if (n === expected) return n;
    await new Promise(r => setTimeout(r, 25));
  }
  return Notification.countDocuments({ userId, type: 'report_message' });
}

describe('report conversations', () => {
  it('lets the reporter and moderators talk, with replies under the message they answer', async () => {
    const reporter = await mkUser('rita');
    const mod = await mkUser('mo', ['users.ban']);
    const reportId = await mkReport(reporter);

    const asked = await addReportMessage(reporter, reportId, 'Any news?');
    const answer = await addReportMessage(mod, reportId, 'Looking into it', asked.id);
    // A reply to a reply joins the same thread.
    await addReportMessage(reporter, reportId, 'Thanks', answer.id);

    const thread = await listReportMessages(mod, reportId);
    expect(thread).toHaveLength(1);
    expect(thread[0].body).toBe('Any news?');
    expect(thread[0].replies.map(r => r.body)).toEqual(['Looking into it', 'Thanks']);
    expect((await messageCounts([reportId])).get(reportId)).toBe(3);
  });

  it('keeps moderators anonymous to the reporter, not to each other', async () => {
    const reporter = await mkUser('rita');
    const mod = await mkUser('mo', ['users.ban']);
    const other = await mkUser('max', ['users.ban']);
    const reportId = await mkReport(reporter);
    await addReportMessage(mod, reportId, 'We removed it');

    const [seenByReporter] = await listReportMessages(reporter, reportId);
    expect(seenByReporter).toMatchObject({ author: null, fromReporter: false, mine: false });
    const [seenByMod] = await listReportMessages(other, reportId);
    expect(seenByMod.author?.accountName).toBe('mo');
  });

  it('hides the conversation from everyone else, as if the report did not exist', async () => {
    const reporter = await mkUser('rita');
    const stranger = await mkUser('sam');
    const reportId = await mkReport(reporter);

    expect(await codeOf(() => listReportMessages(stranger, reportId))).toBe('not_found');
    expect(await codeOf(() => addReportMessage(stranger, reportId, 'hi'))).toBe('not_found');
    expect(await codeOf(() => listReportMessages(reporter, new mongoose.Types.ObjectId().toString()))).toBe('not_found');
  });

  it('refuses an empty or overlong message, and a parent from another report', async () => {
    const reporter = await mkUser('rita');
    const reportId = await mkReport(reporter);
    const otherReport = await mkReport(reporter);
    const elsewhere = await addReportMessage(reporter, otherReport, 'other');

    expect(await codeOf(() => addReportMessage(reporter, reportId, '   '))).toBe('invalid_body');
    expect(await codeOf(() => addReportMessage(reporter, reportId, 'x'.repeat(1001)))).toBe('invalid_body');
    expect(await codeOf(() => addReportMessage(reporter, reportId, 'hi', elsewhere.id))).toBe('not_found');
  });

  it('tells the reporter about a moderator message without naming the moderator', async () => {
    const reporter = await mkUser('rita');
    const mod = await mkUser('mo', ['users.ban']);
    const reportId = await mkReport(reporter);
    await addReportMessage(mod, reportId, 'We removed it');

    expect(await notes(reporter, 1)).toBe(1);
    const note = await Notification.findOne({ userId: reporter, type: 'report_message' }).lean();
    expect(note?.actors).toEqual([]);
    expect(note?.meta).toMatchObject({ reportId, toReporter: true, fromModerator: true });
  });

  it('tells moderators already in the conversation when the reporter writes, and a reply\'s parent author', async () => {
    const reporter = await mkUser('rita');
    const mod = await mkUser('mo', ['users.ban']);
    const bystander = await mkUser('max', ['users.ban']);
    const reportId = await mkReport(reporter);

    // Nobody to tell yet: no moderator has written.
    const first = await addReportMessage(reporter, reportId, 'Hello?');
    expect(await notes(mod, 0)).toBe(0);

    await addReportMessage(mod, reportId, 'Hi', first.id);
    await addReportMessage(reporter, reportId, 'Any update?');
    expect(await notes(mod, 1)).toBe(1);
    expect(await notes(bystander, 0)).toBe(0);
  });
});
