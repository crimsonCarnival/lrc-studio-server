import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import Follow from '../users/follow.model.js';
import { socialGraph } from '../../lib/social-graph.js';
import { getSuggestedUsers } from './explore.service.js';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const ids = new Map<string, mongoose.Types.ObjectId>();
const edges: Array<[string, string]> = [];

beforeEach(async () => {
  await Promise.all([User.collection.deleteMany({}), Follow.collection.deleteMany({})]);
  for (const [a, b] of edges) socialGraph.removeEdge(a, b);
  edges.length = 0;
  ids.clear();
});

let minute = 0;
async function mkUser(name: string, extra: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  ids.set(name, _id);
  // Raw insert: the model's required fields are about sign-up, not what this query reads.
  await User.collection.insertOne({
    _id, accountName: name, displayName: name.toUpperCase(), role: 'user',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)), ...extra,
  });
  return _id.toString();
}

async function follow(a: string, b: string) {
  await Follow.collection.insertOne({ followerId: ids.get(a), followingId: ids.get(b), createdAt: new Date() });
  socialGraph.addEdge(ids.get(a)!.toString(), ids.get(b)!.toString());
  edges.push([ids.get(a)!.toString(), ids.get(b)!.toString()]);
}

describe('getSuggestedUsers', () => {
  it('never suggests someone the viewer already follows, even from the newest-users top-up', async () => {
    const me = await mkUser('me');
    await mkUser('followed');
    await mkUser('stranger');
    await follow('me', 'followed');

    const out = await getSuggestedUsers(me, 8);
    const names = out.map((u) => u.accountName);
    expect(names).toContain('stranger');
    expect(names).not.toContain('followed');
    expect(names).not.toContain('me');
    expect(out.every((u) => u.isFollowedByMe === false)).toBe(true);
    expect(out.find((u) => u.accountName === 'stranger')?.suggestionReason.kind).toBe('NEW');
  });

  it('says who connects a friend of a friend, and puts them first', async () => {
    const me = await mkUser('me');
    await mkUser('ana');
    await mkUser('fof');
    await mkUser('newest');
    await follow('me', 'ana');
    await follow('ana', 'fof');

    const out = await getSuggestedUsers(me, 8);
    expect(out[0].accountName).toBe('fof');
    expect(out[0].suggestionReason).toMatchObject({ kind: 'MUTUAL', mutualCount: 1, mutualName: 'ANA' });
    expect(out.map((u) => u.accountName)).not.toContain('ana');
  });

  it('names shared artists for a taste match and exposes staff roles', async () => {
    const me = await mkUser('me', { musicLibrary: [{ artist: 'Radiohead' }, { artist: 'Ghostemane' }] });
    await mkUser('fan', { role: 'mod', musicLibrary: [{ artist: 'radiohead' }, { artist: 'Ghostemane' }, { artist: 'Other' }] });

    const [fan] = await getSuggestedUsers(me, 8);
    expect(fan.accountName).toBe('fan');
    expect(fan.staffRole).toBe('mod');
    expect(fan.suggestionReason.kind).toBe('TASTE');
    expect(fan.suggestionReason.sharedArtistCount).toBe(2);
    expect(fan.suggestionReason.sharedArtists).toEqual(['radiohead', 'Ghostemane']);
  });
});
