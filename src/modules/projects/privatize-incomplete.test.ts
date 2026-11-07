import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Notification from '../notifications/notification.model.js';
import { privatizeIncomplete, parseArgs, describeMongoTarget, redactSecrets, checkTarget } from './privatize-incomplete.service.js';

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
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), Notification.deleteMany({})]);
});

type L = { text?: string; timestamp?: number | null; endTime?: number | null; words?: { word: string; time: number | null }[]; type?: string };
const oid = () => new mongoose.Types.ObjectId();

// Raw inserts keep the fixture exact (no hooks, no defaults) and let us pin updatedAt.
async function seed(publicId: string, lines: L[] | null, opts: { owner?: mongoose.Types.ObjectId | null; pub?: boolean } = {}) {
  const updatedAt = new Date('2020-01-01T00:00:00Z');
  await Project.collection.insertOne({
    publicId, title: `T-${publicId}`, public: opts.pub ?? true, userId: opts.owner === undefined ? oid() : opts.owner,
    createdAt: updatedAt, updatedAt,
  });
  if (lines) {
    await Lyrics.collection.insertOne({ publicId, sections: [{ label: 'Verse', timestamp: null, lines: lines.map((l) => ({ text: 'x', ...l })) }] });
  }
}
const isPublic = async (id: string) => (await Project.collection.findOne({ publicId: id }) as { public: boolean }).public;

describe('privatizeIncomplete', () => {
  it('privatizes a public project with one untimed line, keeps fully timed public', async () => {
    await seed('partial001', [{ timestamp: 1 }, { timestamp: null }]);
    await seed('full0000001', [{ timestamp: 1 }, { timestamp: 2 }]);
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res.changed).toBe(1);
    expect(res.matched).toEqual([{ publicId: 'partial001', title: 'T-partial001', timed: 1, total: 2 }]);
    expect(await isPublic('partial001')).toBe(false);
    expect(await isPublic('full0000001')).toBe(true);
  });

  it('ignores section markers and treats timestamp 0 as timed', async () => {
    await seed('markers0001', [{ type: 'section', timestamp: null }, { timestamp: 0 }, { timestamp: 4 }]);
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res).toEqual({ matched: [], changed: 0, skippedChanged: 0, failed: [], notifyFailed: [] });
    expect(await isPublic('markers0001')).toBe(true);
  });

  it('counts empty and missing lyrics as incomplete; leaves private projects alone', async () => {
    await seed('empty000001', []);
    await seed('nolyrics001', null);
    await seed('private0001', [{ timestamp: null }], { pub: false });
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res.matched.map((m) => m.publicId).sort()).toEqual(['empty000001', 'nolyrics001']);
    expect(res.changed).toBe(2);
  });

  it('is idempotent and preserves updatedAt', async () => {
    await seed('partial001', [{ timestamp: null }]);
    expect((await privatizeIncomplete({ dryRun: false })).changed).toBe(1);
    expect(await privatizeIncomplete({ dryRun: false })).toEqual({ matched: [], changed: 0, skippedChanged: 0, failed: [], notifyFailed: [] });
    const doc = await Project.collection.findOne({ publicId: 'partial001' }) as { updatedAt: Date };
    expect(doc.updatedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('dry run lists but writes nothing and sends nothing', async () => {
    await seed('partial001', [{ timestamp: null }]);
    const evict = vi.fn(async () => undefined);
    const res = await privatizeIncomplete({ dryRun: true, evictNonOwners: evict });
    expect(res.changed).toBe(0);
    expect(res.matched).toHaveLength(1);
    expect(await isPublic('partial001')).toBe(true);
    expect(await Notification.countDocuments({})).toBe(0);
    expect(evict).not.toHaveBeenCalled();
  });

  it('sends one system notification per owner, not per project', async () => {
    const a = oid();
    const b = oid();
    await seed('a000000001', [{ timestamp: null }], { owner: a });
    await seed('a000000002', [], { owner: a });
    await seed('b000000001', [{ timestamp: null }], { owner: b });
    await privatizeIncomplete({ dryRun: false });
    const notes = await Notification.find({}).lean();
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.type === 'system')).toBe(true);
    const forA = notes.find((n) => n.userId.equals(a));
    expect(forA?.meta).toEqual({ kind: 'projects_privatized', count: 2 });
  });

  it('handles owner-less projects: privatized, nobody notified; eviction is called per project', async () => {
    await seed('guest000001', [{ timestamp: null }], { owner: null });
    const evict = vi.fn(async () => undefined);
    const res = await privatizeIncomplete({ dryRun: false, evictNonOwners: evict });
    expect(res.changed).toBe(1);
    expect(await isPublic('guest000001')).toBe(false);
    expect(await Notification.countDocuments({})).toBe(0);
    expect(evict).toHaveBeenCalledWith('guest000001', null);
  });

  it('treats words-only lines as timed; endTime-only lines stay untimed', async () => {
    await seed('wordsonly01', [{ timestamp: null, words: [{ word: 'a', time: null }, { word: 'b', time: 3 }] }]);
    await seed('endonly0001', [{ timestamp: null, endTime: 5 }]);
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res.matched.map((m) => m.publicId)).toEqual(['endonly0001']);
    expect(await isPublic('wordsonly01')).toBe(true);
  });

  it('skips a project whose lyrics were completed between scan and write', async () => {
    await seed('racing00001', [{ timestamp: null }]);
    const res = await privatizeIncomplete({
      dryRun: false,
      beforeWrite: async (id) => {
        await Lyrics.updateOne({ publicId: id }, { $set: { sections: [{ lines: [{ text: 'x', timestamp: 1 }] }] }, $inc: { version: 1 } });
      },
    });
    expect(res).toMatchObject({ changed: 0, skippedChanged: 1 });
    expect(await isPublic('racing00001')).toBe(true);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('skips when the project content stamp changed after the scan', async () => {
    await seed('racing00002', [{ timestamp: null }]);
    await Project.collection.updateOne({ publicId: 'racing00002' }, { $set: { contentUpdatedAt: new Date('2021-01-01') } });
    const res = await privatizeIncomplete({
      dryRun: false,
      beforeWrite: async (id) => {
        await Project.collection.updateOne({ publicId: id }, { $set: { contentUpdatedAt: new Date('2022-01-01') } });
      },
    });
    expect(res).toMatchObject({ changed: 0, skippedChanged: 1 });
    expect(await isPublic('racing00002')).toBe(true);
  });

  it('preserves contentUpdatedAt and firstPublishedAt', async () => {
    await seed('stamps00001', [{ timestamp: null }]);
    const cu = new Date('2021-05-05T00:00:00Z');
    const fp = new Date('2021-06-06T00:00:00Z');
    await Project.collection.updateOne({ publicId: 'stamps00001' }, { $set: { contentUpdatedAt: cu, firstPublishedAt: fp } });
    expect((await privatizeIncomplete({ dryRun: false })).changed).toBe(1);
    const doc = await Project.collection.findOne({ publicId: 'stamps00001' }) as { contentUpdatedAt: Date; firstPublishedAt: Date };
    expect(doc.contentUpdatedAt).toEqual(cu);
    expect(doc.firstPublishedAt).toEqual(fp);
  });

  it('a notification failure does not abort the run', async () => {
    await seed('notiffail001', [{ timestamp: null }]);
    await seed('notiffail002', [{ timestamp: null }]);
    const spy = vi.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('boom') as never);
    const log = vi.fn();
    const res = await privatizeIncomplete({ dryRun: false, log });
    spy.mockRestore();
    expect(res.changed).toBe(2);
    expect(await isPublic('notiffail001')).toBe(false);
    expect(await isPublic('notiffail002')).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('notification failed'));
  });

  it('one project throwing does not stop others; failures are reported and the notice counts written ones', async () => {
    const o = oid();
    await seed('thrower0001', [{ timestamp: null }], { owner: o });
    await seed('okproject01', [{ timestamp: null }], { owner: o });
    const log = vi.fn();
    const res = await privatizeIncomplete({
      dryRun: false,
      log,
      beforeWrite: async (id) => { if (id === 'thrower0001') throw new Error('write boom mongodb://u:pw@h/db'); },
    });
    expect(res.changed).toBe(1);
    expect(res.failed).toEqual([{ publicId: 'thrower0001', error: 'write boom <redacted-uri>' }]);
    expect(await isPublic('thrower0001')).toBe(true);
    expect(await isPublic('okproject01')).toBe(false);
    const notes = await Notification.find({}).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0].meta).toEqual({ kind: 'projects_privatized', count: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('privatized okproject01'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed (1)'));
  });

  it('a throwing lyrics read or project update fails only that project', async () => {
    await seed('readfail0001', [{ timestamp: null }]);
    await seed('updfail00001', [{ timestamp: null }]);
    await seed('fine0000001', [{ timestamp: null }]);
    const read = vi.spyOn(Lyrics, 'findOne').mockImplementationOnce((() => { throw new Error('read boom'); }) as never);
    const upd = vi.spyOn(Project, 'updateOne').mockRejectedValueOnce(new Error('update boom') as never);
    const res = await privatizeIncomplete({ dryRun: false });
    read.mockRestore();
    upd.mockRestore();
    expect(res.failed).toHaveLength(2);
    expect(res.failed.map((x) => x.error).sort()).toEqual(['read boom', 'update boom']);
    expect(res.changed).toBe(1);
  });

  it('dry run reports unreadable projects in failed', async () => {
    await seed('dryfail0001', [{ timestamp: null }]);
    await seed('dryfail0002', [{ timestamp: null }]);
    const read = vi.spyOn(Lyrics, 'findOne').mockImplementationOnce((() => { throw new Error('read boom'); }) as never);
    const res = await privatizeIncomplete({ dryRun: true });
    read.mockRestore();
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toBe('read boom');
    expect(res.matched).toHaveLength(1);
    expect(res.changed).toBe(0);
  });

  it('records notification failures (including non-Error throws) and continues with other owners', async () => {
    const a = oid();
    const b = oid();
    await seed('nf0000000a1', [{ timestamp: null }], { owner: a });
    await seed('nf0000000b1', [{ timestamp: null }], { owner: b });
    const spy = vi.spyOn(Notification, 'create').mockRejectedValueOnce('string boom mongodb://u:pw@h/db' as never);
    const res = await privatizeIncomplete({ dryRun: false });
    spy.mockRestore();
    expect(res.changed).toBe(2);
    expect(res.notifyFailed).toHaveLength(1);
    expect(res.notifyFailed[0]).toMatchObject({ count: 1, error: 'string boom <redacted-uri>' });
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('persists the notification row even when no socket server exists', async () => {
    await seed('persist0001', [{ timestamp: null }]);
    await privatizeIncomplete({ dryRun: false });
    expect(await Notification.countDocuments({ type: 'system' })).toBe(1);
  });
});

describe('parseArgs', () => {
  it('defaults to dry run', () => expect(parseArgs([])).toEqual({ ok: true, apply: false }));
  it('accepts --apply and explicit --dry-run', () => {
    expect(parseArgs(['--apply'])).toEqual({ ok: true, apply: true });
    expect(parseArgs(['--dry-run'])).toEqual({ ok: true, apply: false });
  });
  it('rejects --apply with --dry-run and unknown arguments', () => {
    expect(parseArgs(['--apply', '--dry-run']).ok).toBe(false);
    expect(parseArgs(['--aply']).ok).toBe(false);
    expect(parseArgs(['--apply', 'extra']).ok).toBe(false);
  });
  it('rejects a literal -- separator', () => {
    expect(parseArgs(['--', '--apply']).ok).toBe(false);
  });
});

describe('describeMongoTarget', () => {
  const cases: [string, string][] = [
    ['mongodb+srv://user:p%40ss@cluster0.x.mongodb.net/lrc?retryWrites=true', 'cluster0.x.mongodb.net/lrc'],
    ['mongodb://u:p@a:27017,b:27017/db', 'a:27017,b:27017/db'],
    ['mongodb://localhost:27017', 'localhost:27017/(default db)'],
    // leak 1: no slash before the query string
    ['mongodb://host:27017?replicaSet=x&tlsCertificateKeyFilePassword=secret', 'host:27017/(default db)'],
    // leak 2: raw "/" in the password
    ['mongodb://user:pa/ss@host/db', 'host/db'],
    ['mongodb://user:p@ss@host:1/db', 'host:1/db'],
    ['mongodb://user:p%40ss@host/db', 'host/db'],
    ['mongodb://u:p@[::1]:27017/db', '[::1]:27017/db'],
    ['mongodb+srv://u:p@h1.example.com/db?authSource=admin&x=secret', 'h1.example.com/db'],
  ];
  it.each(cases)('%s', (uri, expected) => {
    const out = describeMongoTarget(uri);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/secret|pa\/ss|p%40ss|user|:p@/);
  });
  it('never prints anything unparseable', () => {
    expect(describeMongoTarget('not a uri')).toBe('<unparseable target>');
    expect(describeMongoTarget('mongodb://user:pa?ss@host/db')).toBe('<unparseable target>');
    expect(describeMongoTarget('mongodb://user:secret')).toBe('<unparseable target>');
    expect(describeMongoTarget('')).toBe('<unparseable target>');
    expect(describeMongoTarget('mongodb://')).toBe('<unparseable target>');
  });
  it.each([
    'mongodb://user:p@ss?x@host/db',
    'mongodb://admin?x@host/db',
    'mongodb://user:12345?x@host',
    'mongodb://user:pa?ss@host/db',
    'mongodb://host/db?auth=user:secret@evil',
  ])('fails closed when an @ follows the first ?: %s', (uri) => {
    expect(describeMongoTarget(uri)).toBe('<unparseable target>');
  });
  it('still prints targets whose query has no @, any scheme case', () => {
    expect(describeMongoTarget('mongodb+srv://user:p%40ss@host/db?x=y')).toBe('host/db');
    expect(describeMongoTarget('mongodb://user:secret@host?x=y')).toBe('host/(default db)');
    expect(describeMongoTarget('MONGODB://u:p@Host/db')).toBe('Host/db');
  });
});

describe('redactSecrets', () => {
  const uri = 'mongodb+srv://bob:s3c%40ret@cluster.example.com/db?x=1';
  it('removes the uri, userinfo, password and decoded form', () => {
    const msg = `connect failed for ${uri}: auth bob:s3c%40ret rejected, pw s3c@ret, other mongodb://z:q@h/x`;
    const out = redactSecrets(msg, uri);
    expect(out).not.toMatch(/bob|s3c|mongodb:\/\/z|cluster\.example/);
  });
  it('redacts a ?-in-password uri completely', () => {
    const u = 'mongodb://user:pa?ss@host/db';
    const out = redactSecrets(`bad ${u} and fragment pa?ss and user:pa`, u);
    expect(out).not.toMatch(/pa\?ss|user|host/);
  });
  it('strips any mongodb uri even without a known one', () => {
    expect(redactSecrets('boom mongodb://a:b@h/db end')).toBe('boom <redacted-uri> end');
  });
});

describe('checkTarget', () => {
  it('lets a parseable target through for both modes', () => {
    expect(checkTarget(true, 'host/db')).toEqual({ proceed: true });
    expect(checkTarget(false, 'host/db')).toEqual({ proceed: true });
  });
  it('refuses --apply on an unparseable target, warns but proceeds on a dry run', () => {
    const apply = checkTarget(true, '<unparseable target>');
    expect(apply.proceed).toBe(false);
    expect(apply.warning).toMatch(/Nothing was written/);
    const dry = checkTarget(false, '<unparseable target>');
    expect(dry.proceed).toBe(true);
    expect(dry.warning).toBeTruthy();
  });
});
