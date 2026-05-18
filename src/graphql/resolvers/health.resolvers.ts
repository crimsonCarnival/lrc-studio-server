export const healthResolvers = {
  Query: {
    health: async () => ({
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
    }),
  },
};
