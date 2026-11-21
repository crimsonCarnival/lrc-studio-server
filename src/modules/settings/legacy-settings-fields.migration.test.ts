import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Settings from './settings.model.js';
import { unsetLegacySettingsFields } from './legacy-settings-fields.migration.js';

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
  await Settings.deleteMany({});
});

// Through the raw collection: the model no longer knows these paths and would strip them.
const insert = (editor: Record<string, unknown>) =>
  Settings.collection.insertOne({ userId: new mongoose.Types.ObjectId(), editor });

describe('unsetLegacySettingsFields', () => {
  it('clears the legacy fields and keeps everything else', async () => {
    const { insertedId } = await insert({
      nudge: { fine: 0.02, coarse: 0.5, default: 0.2 },
      display: { dualLine: true, showNextLine: false, languageLayout: 'stacked', readingFormat: 'katakana' },
    });
    await insert({ nudge: { fine: 0.01 }, display: { readingFormat: 'hiragana' } });

    expect(await unsetLegacySettingsFields({ dryRun: true })).toBe(1);
    expect(await unsetLegacySettingsFields()).toBe(1);

    const doc = await Settings.collection.findOne({ _id: insertedId });
    expect(doc?.editor).toEqual({
      nudge: { fine: 0.02, default: 0.2 },
      display: { readingFormat: 'katakana' },
    });
    expect(await unsetLegacySettingsFields()).toBe(0);
  });
});
