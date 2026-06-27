import Project from './project.model.js';
import mongoose, { PipelineStage } from 'mongoose';

export type SearchSort = 'RELEVANCE' | 'STARS' | 'NEWEST';

const SEARCH_PATHS = [
  'title',
  'metadata.songName',
  'metadata.songArtist',
  'metadata.songAlbum',
  'metadata.description',
  'metadata.tags',
];

async function searchWithAtlas(
  query: string,
  sortBy: SearchSort,
  offset: number,
  limit: number,
  userId?: string
): Promise<{ projects: unknown[]; total: number }> {
  const filterClause: Record<string, unknown>[] = userId ? [
    {
      should: [
        { equals: { path: 'public', value: true } },
        { equals: { path: 'userId', value: new mongoose.Types.ObjectId(userId) } }
      ],
      minimumShouldMatch: 1
    }
  ] : [{ equals: { path: 'public', value: true } }];

  const searchStage = {
    $search: {
      index: 'projects_search',
      compound: {
        must: [{
          text: {
            query,
            path: SEARCH_PATHS,
            fuzzy: { maxEdits: 1 },
          },
        }],
        filter: filterClause,
      },
    },
  };

  const sortStage: Record<string, unknown> | null =
    sortBy === 'STARS'  ? { $sort: { starCount: -1 } } :
    sortBy === 'NEWEST' ? { $sort: { createdAt: -1 } } :
    null;

  const resultPipeline: PipelineStage[] = [searchStage as PipelineStage];
  if (sortStage) resultPipeline.push(sortStage as unknown as PipelineStage);
  resultPipeline.push({ $skip: offset }, { $limit: limit });

  const countPipeline: PipelineStage[] = [searchStage as PipelineStage, { $count: 'total' }];

  const [projects, countResult] = await Promise.all([
    Project.aggregate(resultPipeline),
    Project.aggregate(countPipeline),
  ]);

  return {
    projects,
    total: (countResult[0] as { total?: number } | undefined)?.total ?? 0,
  };
}

async function searchWithRegex(
  query: string,
  sortBy: SearchSort,
  offset: number,
  limit: number,
  userId?: string
): Promise<{ projects: unknown[]; total: number }> {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const filter = {
    $and: [
      {
        $or: [
          { public: true },
          ...(userId ? [{ userId: new mongoose.Types.ObjectId(userId) }] : [])
        ]
      },
      {
        $or: [
          { title: regex },
          { 'metadata.songName': regex },
          { 'metadata.songArtist': regex },
          { 'metadata.songAlbum': regex },
          { 'metadata.description': regex },
          { 'metadata.tags': regex },
        ]
      }
    ]
  };

  const sortField: Record<string, 1 | -1> =
    sortBy === 'STARS'  ? { starCount: -1 } :
    sortBy === 'NEWEST' ? { createdAt: -1 } :
    { createdAt: -1 };

  const [projects, total] = await Promise.all([
    Project.find(filter).sort(sortField).skip(offset).limit(limit).lean(),
    Project.countDocuments(filter),
  ]);

  return { projects, total };
}

export async function searchProjects(
  query: string,
  sortBy: SearchSort = 'RELEVANCE',
  offset: number = 0,
  limit: number = 20,
  userId?: string
): Promise<{ projects: unknown[]; total: number }> {
  try {
    return await searchWithAtlas(query, sortBy, offset, limit, userId);
  } catch {
    return searchWithRegex(query, sortBy, offset, limit, userId);
  }
}
