import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';

async function mongoosePlugin(fastify: FastifyInstance): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');

  await mongoose.connect(uri, {
    maxPoolSize: 50,        // max concurrent DB connections
    minPoolSize: 10,        // keep 10 warm
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    heartbeatFrequencyMS: 10000,
  });
  fastify.log.info('MongoDB connected');

  fastify.addHook('onClose', async () => {
    await mongoose.connection.close();
  });
}

export default fp(mongoosePlugin, { name: 'mongoose' });