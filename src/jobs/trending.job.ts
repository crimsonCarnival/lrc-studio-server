import { PriorityQueue } from '@crimson-carnival/ds-js';
import ProjectStar from '../modules/projects/project-star.model.js';
import Project from '../modules/projects/project.model.js';
import User from '../modules/users/user.model.js';
import SavedPlaylist from '../modules/playlists/saved-playlist.model.js';
import Playlist from '../modules/playlists/playlist.model.js';
import { computeProjectScores, type EngagementEvent, type ScoreInput } from './trending.score.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type CandidateDoc = {
  publicId: string;
  userId?: { toString(): string } | null;
  createdAt: Date;
  viewCount?: number;
  metadata?: { description?: string; genre?: string; tags?: string[]; singers?: string[] };
};

const hasMetadata = (m: CandidateDoc['metadata']): boolean =>
  !!(m && (m.description || m.genre || m.tags?.length || m.singers?.length));

async function recomputeProjectScores(now: Date): Promise<void> {
  const ago24h = new Date(now.getTime() - DAY_MS);
  const ago30d = new Date(now.getTime() - 30 * DAY_MS);

  // Every public project is scored, not just those with recent activity: without
  // a base score all idle projects tie at 0 and fall back to createdAt order.
  const candidates = await Project.find({ public: true })
    .select('publicId userId createdAt viewCount metadata')
    .lean<CandidateDoc[]>();
  if (candidates.length === 0) return;
  const ownerOf = new Map(candidates.map((c) => [c.publicId, c.userId?.toString() ?? null]));

  const [stars, forks] = await Promise.all([
    ProjectStar.find({ createdAt: { $gte: ago30d } }).select('publicId userId createdAt').lean<{ publicId: string; userId: { toString(): string }; createdAt: Date }[]>(),
    Project.find({ 'forkedFrom.publicId': { $ne: null }, createdAt: { $gte: ago30d } })
      .select('userId createdAt forkedFrom.publicId forkedFrom.userId')
      .lean<{ userId?: { toString(): string } | null; createdAt: Date; forkedFrom: { publicId: string; userId?: { toString(): string } | null } }[]>(),
  ]);

  type Raw = { publicId: string; kind: 'star' | 'fork'; at: Date; actor: string | null };
  const raw: Raw[] = [];
  for (const s of stars) {
    // An owner starring their own project is a bookmark, not a signal.
    if (ownerOf.has(s.publicId) && ownerOf.get(s.publicId) !== s.userId.toString()) {
      raw.push({ publicId: s.publicId, kind: 'star', at: s.createdAt, actor: s.userId.toString() });
    }
  }
  for (const f of forks) {
    const target = f.forkedFrom.publicId;
    const actor = f.userId?.toString() ?? null;
    // Forking your own project is a copy, not social proof.
    if (ownerOf.has(target) && (!actor || actor !== f.forkedFrom.userId?.toString())) {
      raw.push({ publicId: target, kind: 'fork', at: f.createdAt, actor });
    }
  }

  const actorIds = [...new Set(raw.map((r) => r.actor).filter((a): a is string => !!a))];
  const actorDocs = actorIds.length
    ? await User.find({ _id: { $in: actorIds } }).select('createdAt').lean<{ _id: { toString(): string }; createdAt?: Date }[]>()
    : [];
  const actorCreated = new Map(actorDocs.map((u) => [u._id.toString(), u.createdAt ?? null]));

  const actions24h = new Map<string, number>();
  for (const r of raw) {
    if (r.actor && r.at >= ago24h) actions24h.set(r.actor, (actions24h.get(r.actor) ?? 0) + 1);
  }

  const eventsByProject = new Map<string, EngagementEvent[]>();
  for (const r of raw) {
    const ev: EngagementEvent = {
      kind: r.kind,
      at: r.at,
      actorCreatedAt: r.actor ? actorCreated.get(r.actor) ?? null : null,
      actorActions24h: r.actor ? actions24h.get(r.actor) ?? 0 : 0,
    };
    const list = eventsByProject.get(r.publicId);
    if (list) list.push(ev);
    else eventsByProject.set(r.publicId, [ev]);
  }

  const inputs: ScoreInput[] = candidates.map((c) => ({
    publicId: c.publicId,
    ownerId: c.userId?.toString() ?? null,
    createdAt: c.createdAt,
    hasMetadata: hasMetadata(c.metadata),
    viewCount: c.viewCount ?? 0,
    events: eventsByProject.get(c.publicId) ?? [],
  }));
  const scores = computeProjectScores(inputs, now);

  await Project.bulkWrite(
    [...scores].map(([publicId, trendingScore]) => ({
      updateOne: { filter: { publicId, public: true }, update: { $set: { trendingScore } } },
    })),
    { ordered: false, timestamps: false },
  );
}

export async function recomputeTrendingScores(): Promise<void> {
  const now = new Date();
  const ago24h = new Date(now.getTime() - DAY_MS);
  const ago7d = new Date(now.getTime() - 7 * DAY_MS);
  const ago30d = new Date(now.getTime() - 30 * DAY_MS);

  await recomputeProjectScores(now);

  // --- Playlists ---
  const playlistStats = await SavedPlaylist.aggregate<{
    _id: string;
    saves24h: number;
    saves7d: number;
    saves30d: number;
  }>([
    { $match: { savedAt: { $gte: ago30d } } },
    {
      $group: {
        _id: '$playlistId',
        saves24h: { $sum: { $cond: [{ $gte: ['$savedAt', ago24h] }, 1, 0] } },
        saves7d: { $sum: { $cond: [{ $gte: ['$savedAt', ago7d] }, 1, 0] } },
        saves30d: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'playlists',
        localField: '_id',
        foreignField: '_id',
        as: 'playlist',
      },
    },
    { $unwind: '$playlist' },
    { $match: { 'playlist.isPublic': true } },
  ]);

  if (playlistStats.length > 0) {
    const playlistPQ = new PriorityQueue<{ _id: string; score: number }>(
      (a, b) => b.score - a.score  // max-heap: higher scores first
    );

    // Enqueue each playlist's score as it's computed
    for (const p of playlistStats) {
      const score = 10 * p.saves24h + 4 * p.saves7d + 1 * p.saves30d;
      playlistPQ.enqueue({ _id: p._id, score });
    }

    // Extract in sorted order (highest scores first) and prepare bulk writes
    const playlistWrites: Array<{ updateOne: { filter: { _id: string; isPublic: boolean }; update: { $set: { trendingScore: number } } } }> = [];
    while (!playlistPQ.isEmpty()) {
      const item = playlistPQ.dequeue()!;
      playlistWrites.push({
        updateOne: {
          filter: { _id: item._id, isPublic: true },
          update: { $set: { trendingScore: item.score } },
        },
      });
    }

    await Playlist.bulkWrite(playlistWrites, { ordered: false, timestamps: false });
  }

  const activePlaylistIds = playlistStats.map((p) => p._id);
  await Playlist.updateMany(
    { isPublic: true, _id: { $nin: activePlaylistIds } },
    { $set: { trendingScore: 0 } },
    { timestamps: false }
  );
}
