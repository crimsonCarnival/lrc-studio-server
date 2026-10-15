import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Settings from './settings.model.js';
import { settingsResolvers } from '../../graphql/resolvers/settings.resolvers.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Settings.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => { await Settings.deleteMany({}); });

const uid = () => new mongoose.Types.ObjectId().toString();
const ctx = (userId: string) => ({ userId }) as never;
const update = (userId: string, input: Record<string, unknown>) =>
  settingsResolvers.Mutation.updateSettings({}, { input }, ctx(userId));
const read = (userId: string) => Settings.collection.findOne({ userId: new mongoose.Types.ObjectId(userId) }) as Promise<{ export?: Record<string, unknown> } | null>;
const resolveField = (doc: unknown) => settingsResolvers.ExportSettings.includeFeaturedInTitle((doc as { export?: never })?.export ?? null);

describe('export.includeFeaturedInTitle', () => {
  it('reads as false when it was never stored, and nothing is written for it', async () => {
    const u = uid();
    await update(u, { export: { stripEmptyLines: true } });
    const doc = await read(u);
    expect(doc!.export).not.toHaveProperty('includeFeaturedInTitle');
    expect(resolveField(doc)).toBe(false);
  });

  it('persists true and reads it back', async () => {
    const u = uid();
    await update(u, { export: { includeFeaturedInTitle: true } });
    expect(resolveField(await read(u))).toBe(true);
  });

  it('an update that omits it keeps the stored value, and does not erase other export fields', async () => {
    const u = uid();
    await update(u, { export: { includeFeaturedInTitle: true, lineEndings: 'crlf', includeMetadata: true } });
    await update(u, { export: { stripEmptyLines: true } });
    const doc = await read(u);
    expect(doc!.export).toMatchObject({ includeFeaturedInTitle: true, lineEndings: 'crlf', includeMetadata: true, stripEmptyLines: true });
  });

  it('can be turned back off without touching its siblings', async () => {
    const u = uid();
    await update(u, { export: { includeFeaturedInTitle: true, lineEndings: 'crlf' } });
    await update(u, { export: { includeFeaturedInTitle: false } });
    expect((await read(u))!.export).toMatchObject({ includeFeaturedInTitle: false, lineEndings: 'crlf' });
  });

  it('does not change other users', async () => {
    const [a, b] = [uid(), uid()];
    await update(a, { export: { includeFeaturedInTitle: true } });
    await update(b, { export: { stripEmptyLines: true } });
    expect(resolveField(await read(b))).toBe(false);
  });
});
