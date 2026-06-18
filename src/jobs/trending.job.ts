import ProjectStar from '../modules/projects/projectStar.model.js';
import Project from '../modules/projects/project.model.js';
import SavedPlaylist from '../db/saved-playlist.model.js';
import Playlist from '../db/playlist.model.js';

export async function recomputeTrendingScores(): Promise<void> {
  const now = new Date();
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ago30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // --- Project stars ---
  const starStats = await ProjectStar.aggregate<{
    _id: string;
    stars24h: number;
    stars7d: number;
    stars30d: number;
  }>([
    { $match: { createdAt: { $gte: ago30d } } },
    {
      $group: {
        _id: '$publicId',
        stars24h: { $sum: { $cond: [{ $gte: ['$createdAt', ago24h] }, 1, 0] } },
        stars7d: { $sum: { $cond: [{ $gte: ['$createdAt', ago7d] }, 1, 0] } },
        stars30d: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'projects',
        localField: '_id',
        foreignField: 'publicId',
        as: 'project',
      },
    },
    { $unwind: '$project' },
    { $match: { 'project.public': true } },
  ]);

  // --- Project forks ---
  const forkStats = await Project.aggregate<{
    _id: string;
    forks24h: number;
    forks7d: number;
    forks30d: number;
  }>([
    {
      $match: {
        'forkedFrom.publicId': { $ne: null },
        createdAt: { $gte: ago30d },
      },
    },
    {
      $group: {
        _id: '$forkedFrom.publicId',
        forks24h: { $sum: { $cond: [{ $gte: ['$createdAt', ago24h] }, 1, 0] } },
        forks7d: { $sum: { $cond: [{ $gte: ['$createdAt', ago7d] }, 1, 0] } },
        forks30d: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'projects',
        localField: '_id',
        foreignField: 'publicId',
        as: 'project',
      },
    },
    { $unwind: '$project' },
    { $match: { 'project.public': true } },
  ]);

  // Merge stars and forks by publicId
  const forkMap = new Map(forkStats.map((f) => [f._id, f]));
  const starMap = new Map(starStats.map((s) => [s._id, s]));
  const allpublicIds = new Set([...starMap.keys(), ...forkMap.keys()]);

  if (allpublicIds.size > 0) {
    const projectWrites = Array.from(allpublicIds).map((pid) => {
      const s = starMap.get(pid);
      const f = forkMap.get(pid);
      const score =
        7 * (s?.stars24h ?? 0) +
        3 * (s?.stars7d ?? 0) +
        1 * (s?.stars30d ?? 0) +
        14 * (f?.forks24h ?? 0) +
        6 * (f?.forks7d ?? 0) +
        2 * (f?.forks30d ?? 0);
      return {
        updateOne: {
          filter: { publicId: pid, public: true },
          update: { $set: { trendingScore: score } },
        },
      };
    });
    await Project.bulkWrite(projectWrites, { ordered: false });
  }

  await Project.updateMany(
    { public: true, publicId: { $nin: Array.from(allpublicIds) } },
    { $set: { trendingScore: 0 } }
  );

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
    const playlistWrites = playlistStats.map((p) => {
      const score = 10 * p.saves24h + 4 * p.saves7d + 1 * p.saves30d;
      return {
        updateOne: {
          filter: { _id: p._id, isPublic: true },
          update: { $set: { trendingScore: score } },
        },
      };
    });
    await Playlist.bulkWrite(playlistWrites, { ordered: false });
  }

  const activePlaylistIds = playlistStats.map((p) => p._id);
  await Playlist.updateMany(
    { isPublic: true, _id: { $nin: activePlaylistIds } },
    { $set: { trendingScore: 0 } }
  );
}
