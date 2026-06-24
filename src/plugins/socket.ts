import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { setIO } from '../socket/socket.manager.js';
import { setOnline, setOffline, isOnline, getOnlineUserIds } from '../socket/presence.js';
import Follow from '../db/follow.model.js';
import User from '../db/user.model.js';
import type { IUser } from '../db/user.model.js';
import mongoose from 'mongoose';

async function getMutualFollowIds(userId: string): Promise<string[]> {
  const userOid = new mongoose.Types.ObjectId(userId);
  // Users that this user follows
  const following = await Follow.find({ followerId: userOid }).select('followingId').lean();
  const followingIds = following.map(f => f.followingId);
  if (followingIds.length === 0) return [];
  // Of those, which ones follow this user back (mutual)
  const mutuals = await Follow.find({
    followerId: { $in: followingIds },
    followingId: userOid,
  }).select('followerId').lean();
  return mutuals.map(f => f.followerId.toString());
}

async function socketPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = process.env.CORS_ORIGIN!
    .split(',')
    .map((o: string) => o.trim());

  const io = new Server(fastify.server, {
    cors: {
      origin: origins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  setIO(io);
  fastify.addHook('onClose', () => new Promise<void>(res => io.close(() => res())));

  fastify.addHook('onListen', async () => {
    io.on('connection', (socket) => {
      fastify.log.info({ socketId: socket.id }, 'socket connected');

      socket.on('join:user', async (userId: string) => {
        if (typeof userId !== 'string' || userId.length === 0) return;
        socket.join(`user:${userId}`);

        const isNew = setOnline(userId, socket.id);

        // Load user's visibility setting
        const user = await User.findById(userId).select('social permissions').lean<IUser>();
        const visibility = user?.social?.onlineVisibility ?? 'friends';

        const mutualIds = await getMutualFollowIds(userId);

        if (isNew) {
          // Notify friends + admin room that this user came online
          if (visibility !== 'nobody') {
            for (const friendId of mutualIds) {
              io.to(`user:${friendId}`).emit('presence:online', { userId });
            }
          }
          io.to('admin').emit('presence:online', { userId });
        }

        // Send the connecting socket the list of online mutual friends visible to them
        const onlineFriendIds = mutualIds.filter(fid => isOnline(fid));
        const friendDocs = onlineFriendIds.length > 0
          ? await User.find({ _id: { $in: onlineFriendIds.map(id => new mongoose.Types.ObjectId(id)) } })
              .select('social')
              .lean<IUser[]>()
          : [];
        const visibleFriendIds = friendDocs
          .filter(u => (u.social?.onlineVisibility ?? 'friends') !== 'nobody')
          .map(u => u._id.toString());

        socket.emit('presence:init', { onlineUserIds: visibleFriendIds });
      });

      socket.on('join:admin', async () => {
        socket.join('admin');
        // Send all currently online users to the admin socket
        socket.emit('presence:init', { onlineUserIds: getOnlineUserIds() });
      });

      socket.on('join:project', (publicId: string) => {
        if (typeof publicId === 'string' && publicId.length > 0) {
          socket.join(`project:${publicId}`);
        }
      });

      socket.on('leave:project', (publicId: string) => {
        socket.leave(`project:${publicId}`);
      });

      socket.on('disconnect', async (reason) => {
        fastify.log.info({ socketId: socket.id, reason }, 'socket disconnected');

        const result = setOffline(socket.id);
        if (!result?.lastSocket) return;

        const { userId } = result;
        const user = await User.findById(userId).select('social').lean<IUser>();
        const visibility = user?.social?.onlineVisibility ?? 'friends';
        const mutualIds = await getMutualFollowIds(userId);

        if (visibility !== 'nobody') {
          for (const friendId of mutualIds) {
            io.to(`user:${friendId}`).emit('presence:offline', { userId });
          }
        }
        io.to('admin').emit('presence:offline', { userId });
      });
    });
  });
}

export default fp(socketPlugin, { name: 'socket', dependencies: ['cors'] });
