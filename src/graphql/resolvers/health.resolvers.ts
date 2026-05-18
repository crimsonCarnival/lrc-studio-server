import { getHealth } from '../../modules/health/health.service.js';

export const healthResolvers = {
  Query: {
    health: async () => {
      const h = await getHealth();
      return { status: h.status, version: h.version, uptime: h.uptime };
    },
  },
};
