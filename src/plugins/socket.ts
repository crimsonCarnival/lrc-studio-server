import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { setIO } from '../socket/socket.manager.js';
import { initSocialGraph } from '../lib/social-graph.js';
import { initRequestQueue } from '../modules/requests/request.queue.js';
import { loadHeap, scheduleEviction, cancelEviction } from '../lib/notification-heap.js';
import { setOnline, setOffline, isOnline, getOnlineUserIds, setActivity, clearActivity, getActivity, getUserForSocket } from '../socket/presence.js';
import type { UserActivity } from '../socket/presence.js';
import Follow from '../db/follow.model.js';
import User from '../db/user.model.js';
import type { IUser } from '../db/user.model.js';
import { hasPermission } from '../shared/permissions.js';
import mongoose from 'mongoose';
import { getPreferences } from '../modules/user-preferences/user-preferences.service.js';
import Project from '../modules/projects/project.model.js';
import {
  isValidPublicId,
  addViewer,
  removeViewer,
  removeSocket as removeViewerSocket,
  getViewerSummary,
} from '../socket/project-viewers.js';

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

  /** Coalesce roster emits per project — joins arrive in bursts, one per tab. */
  const rosterTimers = new Map<string, NodeJS.Timeout>();
  const ROSTER_DEBOUNCE_MS = 500;

  /**
   * Build and emit the viewer roster for one project, to the OWNER ROOM ONLY.
   *
   * Named avatars are gated on the viewer's own onlineVisibility: anyone set to
   * 'nobody' folds into anonymousCount and their identity is never sent. The
   * looser-than-'everyone' gate is deliberate and documented in the spec — the
   * roster goes to exactly one person, is never persisted, and 'friends' is the
   * platform default, so requiring 'everyone' would make the feature useless.
   */
  async function emitRoster(publicId: string): Promise<void> {
    const room = `project-owner:${publicId}`;
    // Nobody is listening — skip the user lookups entirely.
    if ((await io.in(room).fetchSockets()).length === 0) return;

    const { userIds, anonymousCount } = getViewerSummary(publicId);

    let viewers: Array<{ userId: string; accountName: string; displayName?: string | null; avatarUrl?: string | null }> = [];
    let hidden = 0;

    if (userIds.length > 0) {
      // Same isDeleted/ban filter as join:admin — a soft-deleted or banned
      // account's name and avatar must not reach the owner.
      const users = await User.find({ _id: { $in: userIds }, isDeleted: { $ne: true }, 'ban.active': { $ne: true } })
        .select('accountName displayName avatarUrl')
        .lean<Array<{ _id: mongoose.Types.ObjectId; accountName?: string; displayName?: string | null; avatarUrl?: string | null }>>();

      const resolved = await Promise.all(users.map(async (u) => {
        const prefs = await getPreferences(u._id.toString());
        if (prefs.onlineVisibility === 'nobody') return null;
        return {
          userId: u._id.toString(),
          accountName: u.accountName ?? '',
          displayName: u.displayName ?? null,
          avatarUrl: u.avatarUrl ?? null,
        };
      }));

      viewers = resolved.filter((v): v is NonNullable<typeof v> => v !== null);
      // Computed against userIds.length, not users.length/resolved.length: a
      // hard-deleted account or stale registry entry that User.find doesn't
      // return must still fold into anonymousCount rather than vanish from
      // the total.
      hidden = userIds.length - viewers.length;
    }

    io.to(room).emit('viewers:update', {
      publicId,
      viewers,
      anonymousCount: anonymousCount + hidden,
    });
  }

  /** Schedule a coalesced roster emit. */
  function scheduleRoster(publicId: string): void {
    // Synchronous room-size check: never arm a timer for a project nobody is
    // watching. publicId is unauthenticated and client-supplied (viewers:join
    // takes no auth), so without this a client can flood millions of distinct
    // ids and each one would still mint a setTimeout — the async empty-room
    // check inside emitRoster only guards after the timer has already fired.
    if (!io.sockets.adapter.rooms.get(`project-owner:${publicId}`)?.size) return;
    if (rosterTimers.has(publicId)) return;
    rosterTimers.set(publicId, setTimeout(() => {
      rosterTimers.delete(publicId);
      void emitRoster(publicId).catch((err) => {
        fastify.log.error({ err, publicId }, 'viewers roster emit failed');
      });
    }, ROSTER_DEBOUNCE_MS));
  }

  fastify.addHook('onListen', async () => {
    await initSocialGraph();
    fastify.log.info('Social graph initialized');
    await initRequestQueue();
    fastify.log.info('Request queue initialized');
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

        // Load from LRU cache — near-zero cost on cache hit
        const prefs = await getPreferences(userId);

        const mutualIds = await getMutualFollowIds(userId);

        if (isNew) {
          // Admins bypass privacy preferences and always get notified
          io.to('admin').emit('presence:online', { userId });
          
          if (prefs.onlineVisibility !== 'nobody') {
            // Notify mutual friends
            for (const friendId of mutualIds) {
              io.to(`user:${friendId}`).emit('presence:online', { userId });
            }
          }
        }

        // Send the connecting socket the list of online mutual friends visible to them.
        // The socket room model limits recipients to mutuals in all cases; 'nobody' only
        // suppresses this user's own visibility, not what they can see of others.
        const onlineFriendIds = mutualIds.filter(fid => isOnline(fid));
        const visibleFriendIds = onlineFriendIds;

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

        const event = { userId, activity };
        // Admins bypass privacy
        io.to('admin').emit('activity:update', event);

        const actPrefs = await getPreferences(userId);
        if (actPrefs.onlineVisibility !== 'nobody') {
          const mutualIds = await getMutualFollowIds(userId);
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('activity:update', event);
        }
      });

      socket.on('activity:clear', async () => {
        const userId = getUserForSocket(socket.id);
        if (!userId) return;

        clearActivity(userId);

        const event = { userId };
        // Admins bypass privacy
        io.to('admin').emit('activity:clear', event);

        const clearPrefs = await getPreferences(userId);
        if (clearPrefs.onlineVisibility !== 'nobody') {
          const mutualIds = await getMutualFollowIds(userId);
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('activity:clear', event);
        }
      });

      socket.on('join:project', (publicId: string) => {
        if (typeof publicId === 'string' && publicId.length > 0) {
          socket.join(`project:${publicId}`);
        }
      });

      socket.on('leave:project', (publicId: string) => {
        socket.leave(`project:${publicId}`);
      });

      // Any viewer — including anonymous ones — announces presence on a project page.
      socket.on('viewers:join', (publicId: unknown) => {
        if (!isValidPublicId(publicId)) return;
        addViewer(publicId, socket.id, socket.data.userId as string | undefined);
        scheduleRoster(publicId);
      });

      socket.on('viewers:leave', (publicId: unknown) => {
        if (!isValidPublicId(publicId)) return;
        removeViewer(publicId, socket.id);
        scheduleRoster(publicId);
      });

      // Owner-only subscription to the roster. Ownership is resolved from the DB
      // against the identity in the verified handshake JWT — never from an
      // argument — and a mismatch is a silent no-op, matching how the other
      // identity-requiring handlers behave.
      socket.on('viewers:watch', async (publicId: unknown) => {
        if (!isValidPublicId(publicId)) return;
        const userId = socket.data.userId as string | undefined;
        if (!userId) return;

        try {
          const project = await Project.findOne({ publicId })
            .select('userId')
            .lean<{ userId?: mongoose.Types.ObjectId | null }>();
          // Ownership failure stays a silent no-op — a client must not be able
          // to probe which projects exist or who owns them via an error emit.
          if (!project?.userId || project.userId.toString() !== userId) return;

          socket.join(`project-owner:${publicId}`);
          // Immediate, un-debounced: the owner just arrived and needs the current state.
          await emitRoster(publicId);
        } catch (err) {
          // A genuine failure (DB blip, etc.) — not an ownership mismatch — so
          // it's logged rather than silently swallowed. Socket.IO does not
          // catch rejections from async listeners and this process installs
          // no unhandledRejection handler, so leaving this unguarded would
          // crash the server on a single DB error.
          fastify.log.error({ err, publicId }, 'viewers:watch failed');
        }
      });

      // Symmetric with viewers:watch. No ownership check needed or wanted —
      // leaving a room you are not in is a harmless no-op, and requiring a DB
      // lookup to drop a privilege would be backwards.
      socket.on('viewers:unwatch', (publicId: unknown) => {
        if (!isValidPublicId(publicId)) return;
        socket.leave(`project-owner:${publicId}`);
      });

      socket.on('disconnect', async (reason) => {
        fastify.log.info({ socketId: socket.id, reason }, 'socket disconnected');

        // A closed tab or dropped network rarely sends a clean viewers:leave, so
        // disconnect is the primary eviction path, not the fallback.
        for (const publicId of removeViewerSocket(socket.id)) scheduleRoster(publicId);

        const result = setOffline(socket.id);
        if (!result?.lastSocket) return;

        const { userId } = result;
        
        User.updateOne({ _id: userId }, { lastOnlineAt: new Date() }).catch(err => {
          fastify.log.error({ err, userId }, 'failed to update lastOnlineAt');
        });

        // Admins bypass privacy
        io.to('admin').emit('presence:offline', { userId });

        const disconnectPrefs = await getPreferences(userId);
        if (disconnectPrefs.onlineVisibility !== 'nobody') {
          const mutualIds = await getMutualFollowIds(userId);
          for (const friendId of mutualIds) io.to(`user:${friendId}`).emit('presence:offline', { userId });
        }
        scheduleEviction(userId);
      });
    });
  });
}

export default fp(socketPlugin, { name: 'socket', dependencies: ['cors'] });
