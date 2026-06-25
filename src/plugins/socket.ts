import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { setIO } from '../socket/socket.manager.js';
import { initSocialGraph } from '../lib/social-graph.js';
import { loadHeap, scheduleEviction, cancelEviction } from '../lib/notification-heap.js';
import { setOnline, setOffline, isOnline, getOnlineUserIds, setActivity, clearActivity, getActivity, getUserForSocket } from '../socket/presence.js';
import type { UserActivity } from '../socket/presence.js';
import Follow from '../db/follow.model.js';
import User from '../db/user.model.js';
import type { IUser } from '../db/user.model.js';
import { hasPermission } from '../shared/permissions.js';
import mongoose from 'mongoose';

const JWT_SECRET = process.env.JWT_SECRET!;

/** Parse a raw Cookie header string and return the value for a given name. */
function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

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

  // Auth middleware: verify JWT from the accessToken cookie sent in the handshake.
  // Allows anonymous connections (socket.data.userId stays undefined); handlers
  // that require identity silently no-op when userId is absent.
  io.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      const token = parseCookie(cookieHeader, 'accessToken');
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string };
        if (decoded.sub) socket.data.userId = decoded.sub;
      }
    } catch {
      // Expired / malformed token — treat as anonymous
    }
    next();
  });

  fastify.addHook('onListen', async () => {
    await initSocialGraph();
    fastify.log.info('Social graph initialized');
    io.on('connection', (socket) => {
      fastify.log.info({ socketId: socket.id }, 'socket connected');

      socket.on('join:user', async () => {
        // Identity comes only from the verified JWT in the handshake, never from
        // a client-supplied argument — prevents impersonation.
        const userId = socket.data.userId as string | undefined;
        if (!userId) return;
        socket.join(`user:${userId}`);
        await loadHeap(userId);
        cancelEviction(userId);

        const isNew = setOnline(userId, socket.id);

        // Load user's visibility setting
        const user = await User.findById(userId).select('privacy permissions').lean<IUser>();
        const visibility = user?.privacy?.onlineVisibility ?? 'friends';

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
              .select('privacy')
              .lean<IUser[]>()
          : [];
        const visibleFriendIds = friendDocs
          .filter(u => (u.privacy?.onlineVisibility ?? 'friends') !== 'nobody')
          .map(u => u._id.toString());

        const activities: Record<string, UserActivity> = {};
        for (const fid of visibleFriendIds) {
          const act = getActivity(fid);
          if (act) activities[fid] = act;
        }
        socket.emit('presence:init', { onlineUserIds: visibleFriendIds, activities });
      });

      socket.on('join:admin', async () => {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return;

        // Verify server-side that this user actually has admin permissions.
        const user = await User.findById(userId).select('permissions ban isDeleted').lean<IUser>();
        if (!user || user.isDeleted || user.ban?.active) return;
        if (!hasPermission(user.permissions, 'users.view')) return;

        socket.join('admin');
        const onlineUserIds = getOnlineUserIds();
        const activities: Record<string, UserActivity> = {};
        for (const uid of onlineUserIds) {
          const act = getActivity(uid);
          if (act) activities[uid] = act;
        }
        socket.emit('presence:init', { onlineUserIds, activities });
      });

      socket.on('activity:set', async (payload: unknown) => {
        const userId = getUserForSocket(socket.id);
        if (!userId) return;
        const p = payload as Partial<UserActivity>;
        if (typeof p?.projectTitle !== 'string') return;

        const activity: UserActivity = {
          projectTitle: p.projectTitle,
          songName: p.songName ?? '',
          publicId: p.publicId ?? '',
        };
        setActivity(userId, activity);

        const [user, mutualIds] = await Promise.all([
          User.findById(userId).select('privacy').lean<IUser>(),
          getMutualFollowIds(userId),
        ]);
        const visibility = user?.privacy?.onlineVisibility ?? 'friends';
        const event = { userId, activity };
        if (visibility !== 'nobody') {
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('activity:update', event);
        }
        io.to('admin').emit('activity:update', event);
      });

      socket.on('activity:clear', async () => {
        const userId = getUserForSocket(socket.id);
        if (!userId) return;

        clearActivity(userId);

        const [user, mutualIds] = await Promise.all([
          User.findById(userId).select('privacy').lean<IUser>(),
          getMutualFollowIds(userId),
        ]);
        const visibility = user?.privacy?.onlineVisibility ?? 'friends';
        const event = { userId };
        if (visibility !== 'nobody') {
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('activity:clear', event);
        }
        io.to('admin').emit('activity:clear', event);
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
        const [user, mutualIds] = await Promise.all([
          User.findById(userId).select('privacy').lean<IUser>(),
          getMutualFollowIds(userId),
        ]);
        const visibility = user?.privacy?.onlineVisibility ?? 'friends';
        if (visibility !== 'nobody') {
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('presence:offline', { userId });
        }
        io.to('admin').emit('presence:offline', { userId });
        scheduleEviction(userId);
      });
    });
  });
}

export default fp(socketPlugin, { name: 'socket', dependencies: ['cors'] });
