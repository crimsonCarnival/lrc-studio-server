import { getTrendingProjects, getPopularPlaylists, getSuggestedUsers, getExploreStats } from '../../modules/explore/explore.service.js';
import { Context } from './context.js';

export const exploreResolvers = {
  Query: {
    trendingProjects: async (
      _root: any,
      { offset = 0, limit = 12 }: { offset?: number; limit?: number },
      context: Context
    ) => {
      return getTrendingProjects(offset, limit, context.userId ?? undefined);
    },
    popularPlaylists: async (
      _root: any,
      { offset = 0, limit = 12 }: { offset?: number; limit?: number }
    ) => {
      return getPopularPlaylists(offset, limit);
    },
    suggestedUsers: async (
      _root: any,
      { limit = 8 }: { limit?: number },
      context: Context
    ) => {
      return getSuggestedUsers(context.userId ?? '', limit);
    },
    exploreStats: async () => {
      return getExploreStats();
    },
  },
};
