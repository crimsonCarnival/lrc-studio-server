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

describe('newly persisted client settings', () => {
  it('stores theme, playerPosition and the autoStamp section without touching siblings', async () => {
    const u = uid();
    await update(u, { interface: { fontSize: 'large' } });
    await update(u, {
      interface: { theme: 'light', focusContrast: 'high' },
      editor: { playerPosition: 'top', overlapThreshold: 0.1 },
      advanced: { autoSaveIndicator: 'long' },
      autoStamp: { confidenceThreshold: 0.9, fuzzyTolerance: 0.6, applyMode: 'all' },
    });
    const doc = (await Settings.findOne({ userId: u }))!.toObject() as Record<string, Record<string, unknown>>;
    expect(doc.interface).toMatchObject({ fontSize: 'large', theme: 'light', focusContrast: 'high' });
    expect(doc.editor).toMatchObject({ playerPosition: 'top', overlapThreshold: 0.1 });
    expect(doc.advanced).toMatchObject({ autoSaveIndicator: 'long' });
    expect(doc.autoStamp).toMatchObject({ confidenceThreshold: 0.9, fuzzyTolerance: 0.6, applyMode: 'all' });
  });

  it('stores a palette theme id', async () => {
    const u = uid();
    await update(u, { interface: { theme: 'rose-pine-dawn' } });
    expect(((await Settings.findOne({ userId: u }))!.toObject() as Record<string, Record<string, unknown>>).interface.theme).toBe('rose-pine-dawn');
  });

  it('a document written before these fields existed reads them back as undefined (GraphQL null), not an error', async () => {
    const u = uid();
    await Settings.collection.insertOne({ userId: new mongoose.Types.ObjectId(u), interface: { fontSize: 'small' } });
    const doc = (await settingsResolvers.Query.settings({}, {}, ctx(u))) as unknown as { interface: Record<string, unknown>; autoStamp?: Record<string, unknown> };
    expect(doc.interface.theme).toBeUndefined();
    expect(doc.autoStamp?.applyMode).toBeUndefined();
  });
});
