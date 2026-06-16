import { getUserContentStats } from '../../modules/stats/content-stats.service.js';
import { Context } from './context.js';

export const statsResolvers = {
  Query: {
    userContentStats: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return getUserContentStats(context.userId);
    },
  },
};
