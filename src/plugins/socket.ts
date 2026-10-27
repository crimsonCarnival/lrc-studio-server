import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/mongo-adapter';
import { parseCookie } from 'cookie';
import { verifyLiveAccessToken } from './auth.js';
import { wallRoom } from '../modules/wall/wall.service.js';
import { setIO } from '../socket/socket.manager.js';
import { initSocialGraph } from '../lib/social-graph.js';
import { initRequestQueue } from '../modules/requests/request.queue.js';
import { loadHeap, scheduleEviction, cancelEviction } from '../lib/notification-heap.js';
import { setOnline, setOffline, isOnline, getOnlineUserIds, setActivity, clearActivity, getActivity, getUserForSocket } from '../socket/presence.js';
import type { UserActivity } from '../socket/presence.js';
import Follow from '../modules/users/follow.model.js';
import User from '../modules/users/user.model.js';
import type { IUser } from '../modules/users/user.model.js';
import { hasPermission } from '../shared/permissions.js';
import mongoose from 'mongoose';
import { getEnv } from '../config/env.js';
import { getPreferences } from '../modules/user-preferences/user-preferences.service.js';
import Project from '../modules/projects/project.model.js';
import {
  isValidPublicId,
  addViewer,
  removeViewer,
  removeSocket as removeViewerSocket,
  getViewerSummary,
} from '../socket/project-viewers.js';
import { parseAllowedOrigins } from '../config/allowed-origins.js';



/** Collection the Mongo adapter writes broadcast + heartbeat documents to. */
const ADAPTER_COLLECTION = 'socket_io_adapter_events';
/** Adapter documents are transient routing traffic — an hour is ample. */
const ADAPTER_EVENT_TTL_SECONDS = 3600;

/**
 * Installs a cross-instance Socket.IO adapter when SOCKET_IO_ADAPTER=mongo.
 *
 * Without one, `io.to(room).emit(...)` only reaches sockets held by the
 * emitting process, so with more than one instance every broadcast is
 * silently partial. Opt-in because the adapter is pure overhead on a single
 * instance (a change stream plus a heartbeat write every 5s, and every
 * broadcast round-tripped through a collection write).
 *
 * Fails soft on purpose: a dev database without change streams (a standalone
 * mongod, e.g. the one in docker-compose.yml) logs a warning and keeps the
 * default in-memory adapter rather than refusing to boot — single-instance
 * dev is exactly the case the in-memory adapter already handles correctly.
 */
async function setupSocketAdapter(fastify: FastifyInstance, io: Server): Promise<void> {
  if (getEnv().SOCKET_IO_ADAPTER !== 'mongo') {
    fastify.log.info('Socket.IO adapter: in-memory (single instance; set SOCKET_IO_ADAPTER=mongo to scale out)');
    return;
  }

  const db = mongoose.connection.db;
  if (!db) {
    fastify.log.error('Socket.IO adapter: SOCKET_IO_ADAPTER=mongo but no database connection — falling back to in-memory');
    return;
  }

  try {
    const collection = db.collection(ADAPTER_COLLECTION);
    // TTL rather than a capped collection: it matches how every other
    // transient collection here is bounded (sessions, email verifications,
    // one-time tokens) and needs no createCollection-then-ignore-the-error
    // dance. `addCreatedAtField` below is what populates the indexed field.
    await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: ADAPTER_EVENT_TTL_SECONDS });

    // Probe before installing: the adapter opens its change stream lazily, so
    // on a cluster that doesn't support them the failure would otherwise
    // surface as an unhandled async error well after boot, with broadcasts
    // quietly not working in the meantime.
    const probe = collection.watch();
    try {
      await probe.close();
    } catch { /* already closed */ }

    // The adapter resolves mongodb@6 types; Mongoose 9 ships mongodb@7. Same runtime driver API.
    io.adapter(createAdapter(collection as unknown as Parameters<typeof createAdapter>[0], { addCreatedAtField: true }));
    fastify.log.info({ collection: ADAPTER_COLLECTION }, 'Socket.IO adapter: mongo (cross-instance broadcasts enabled)');
  } catch (err) {
    fastify.log.error(
      { err },
      'Socket.IO adapter: mongo requested but change streams are unavailable (needs a replica set or sharded cluster) — falling back to in-memory. Cross-instance broadcasts will NOT work.'
    );
  }
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

const ACTIVITY_TEXT_MAX = 200;

async function socketPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = parseAllowedOrigins(process.env.CORS_ORIGIN);

  const io = new Server(fastify.server, {
    cors: {
      origin: origins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
    // Off by default since Socket.IO v3. Unlike REST/GraphQL, these frames
    // never cross the Vercel/Cloudflare edge — the client connects straight
    // to the API origin — so there is no CDN compressing them as a
    // backstop. `project:updated` in particular can carry a full lyrics
    // document (see emitProjectUpdated), which compresses well: repeated
    // field names, repeated chorus lines. Threshold keeps small frames
    // (pings, acks, presence) from paying compression overhead that costs
    // more than it saves.
    perMessageDeflate: { threshold: 1024 },
  });

  setIO(io);
  fastify.addHook('onClose', () => new Promise<void>(res => io.close(() => res())));

  // Auth middleware: verify JWT from the accessToken cookie sent in the handshake.
  // Allows anonymous connections (socket.data.userId stays undefined); handlers
  // that require identity silently no-op when userId is absent.
  // Same verification as the HTTP decorators: access tokens only (a refresh
  // token used to pass here too), bound to a live session, and never for a
  // deleted or banned account.
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? '';
      const token = parseCookie(cookieHeader).accessToken;
      if (token) {
        const decoded = await verifyLiveAccessToken(token);
        const user = decoded.sub
          ? await User.findById(decoded.sub).select('isDeleted ban').lean<IUser>()
          : null;
        if (user && !user.isDeleted && !user.ban?.active) socket.data.userId = decoded.sub;
      }
    } catch {
      // Expired / malformed / revoked token — treat as anonymous
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
    // Before any connection handler is wired, so no socket can join a room
    // the adapter isn't yet aware of. This plugin registers ahead of the
    // mongoose one in server.ts, so the connection isn't open at
    // registration time — onListen is the first point where it is.
    await setupSocketAdapter(fastify, io);
    await initSocialGraph();
    fastify.log.info('Social graph initialized');
    await initRequestQueue();
    fastify.log.info('Request queue initialized');
    io.on('connection', (socket) => {
      fastify.log.info({ socketId: socket.id }, 'socket connected');

      // Watching a profile wall live: changes arrive as 'wall:event' and each viewer refetches
      // what they may see. Anyone who can open the wall may watch it, guests included.
      socket.on('wall:watch', async (accountName: unknown) => {
        if (typeof accountName !== 'string' || accountName.length > 60) return;
        const room = await wallRoom((socket.data.userId as string | undefined) ?? null, accountName);
        if (!room) return;
        for (const r of socket.rooms) if (r.startsWith('wall:') && r !== room) socket.leave(r);
        socket.join(room);
      });
      socket.on('wall:unwatch', () => {
        for (const r of socket.rooms) if (r.startsWith('wall:')) socket.leave(r);
      });

      socket.on('join:user', async (ack?: unknown) => {
        // Identity comes only from the verified JWT in the handshake, never from
        // a client-supplied argument — prevents impersonation.
        const userId = socket.data.userId as string | undefined;
        // Tell the client whether it got in: a socket that connected before sign-in (or
        // with an expired token) is anonymous, and only reconnecting re-reads the cookie.
        // Without this answer it would sit outside its user room, missing every push.
        if (typeof ack === 'function') (ack as (ok: boolean) => void)(!!userId);
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

        // Relayed verbatim to friends and the admin room, so bound it.
        const activity: UserActivity = {
          projectTitle: p.projectTitle.slice(0, ACTIVITY_TEXT_MAX),
          songName: typeof p.songName === 'string' ? p.songName.slice(0, ACTIVITY_TEXT_MAX) : '',
          publicId: isValidPublicId(p.publicId) ? p.publicId : '',
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

      // The `project:{id}` room carries the full `project:updated` payload
      // (lyrics content on an autosave, reactions, etc.), so joining it must
      // require the same visibility rule the REST/GraphQL share path uses —
      // the owner, or a project that is actually public. Unlike
      // `viewers:watch` below this is reachable by anonymous sockets (public
      // viewers are allowed), so ownership is just one of two valid cases
      // rather than the only one. A failure is a silent no-op, matching the
      // other identity-requiring handlers — it must not let a client probe
      // which `publicId`s exist or are private.
      socket.on('join:project', async (publicId: unknown) => {
        if (!isValidPublicId(publicId)) return;
        try {
          const project = await Project.findOne({ publicId })
            .select('userId public')
            .lean<{ userId?: mongoose.Types.ObjectId | null; public?: boolean }>();
          if (!project) return;
          const userId = socket.data.userId as string | undefined;
          const isOwner = !!userId && !!project.userId && project.userId.toString() === userId;
          if (!isOwner && project.public !== true) return;
          socket.join(`project:${publicId}`);
        } catch {
          // DB hiccup: fail closed, same as the other ownership checks here.
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
