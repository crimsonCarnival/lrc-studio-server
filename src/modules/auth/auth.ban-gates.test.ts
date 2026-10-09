/**
 * Ban gates on the credential paths.
 *
 * auth.ban.test.ts covers the decorators, which guard requests from an
 * already-issued session. These cover the other half: whether a banned IP,
 * banned device or ban-linked IP can obtain a session in the first place, and
 * what refresh does with one it already has.
 *
 * Note the deliberate design being asserted here: a banned *user* is still
 * issued tokens on login, so the client can render BannedScreen and the appeal
 * form. The ban is enforced per-request from Mongo, never trusted from the JWT.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../user_logs/logs.service.js', () => ({ logUserAction: () => undefined }));
vi.mock('../email-verification/email-verification.service.js', () => ({
  sendVerification: async () => undefined,
  resendVerification: async () => undefined,
}));
vi.mock('../notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  resolveSticky: async () => undefined,
}));

import User from '../../db/user.model.js';
import Session from '../../db/session.model.js';
import UserDevice from './userDevice.model.js';
import BannedIp from '../admin/bannedIp.model.js';
import BannedDevice from '../admin/bannedDevice.model.js';
import { jwtTools } from '../../plugins/auth.js';
import { register, login, refresh, checkIdentifier } from './auth.service.js';

let repl: MongoMemoryReplSet;

const CLEAN_IP = '198.51.100.20';
const BAD_IP = '203.0.113.20';
const PASSWORD = 'Correct-Horse-9!';
let passwordHash: string;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), Session.init(), UserDevice.init()]);
  // Argon2id at the project's settings is deliberately slow — hash once and
  // reuse, rather than paying for it in every test.
  passwordHash = await User.hashPassword(PASSWORD);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Session.deleteMany({}), UserDevice.deleteMany({}),
    BannedIp.deleteMany({}), BannedDevice.deleteMany({}),
  ]);
});

let n = 0;
type Made = { id: string; accountName: string; email: string };
async function mkUser(opts: {
  role?: string;
  banned?: boolean;
  banUntil?: Date | null;
  lastIp?: string;
  isDeleted?: boolean;
} = {}): Promise<Made> {
  n++;
  const accountName = `gate${n}`;
  const email = `${accountName}@x.test`;
  const res = await User.collection.insertOne({
    accountName,
    email,
    passwordHash,
    isDeleted: !!opts.isDeleted,
    role: opts.role ?? 'user',
    permissions: [],
    lastIp: opts.lastIp ?? null,
    ban: {
      active: !!opts.banned,
      reason: opts.banned ? 'spam' : null,
      until: opts.banUntil ?? null,
    },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
  });
  return { id: res.insertedId.toString(), accountName, email };
}

type Res = { error?: string; code?: string; status?: number; accessToken?: string; refreshToken?: string };

const doLogin = (identifier: string, password: string, ip = CLEAN_IP, deviceId = 'dev-ok') =>
  login({ identifier, password }, jwtTools, ip, deviceId) as Promise<Res>;

describe('register — ban gates', () => {
  it('registers a clean user', async () => {
    const res = await register(
      { accountName: 'freshuser', email: 'fresh@x.test', password: PASSWORD },
      jwtTools, CLEAN_IP, 'dev-fresh',
    ) as Res;
    expect(res.error).toBeUndefined();
    expect(res.accessToken).toBeTruthy();
  });

  it('refuses a banned IP', async () => {
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await register(
      { accountName: 'evader1', email: 'evader1@x.test', password: PASSWORD },
      jwtTools, BAD_IP, 'dev-x',
    ) as Res;
    expect(res.code).toBe('ip_banned_register');
    expect(res.status).toBe(403);
    expect(await User.countDocuments({ accountName: 'evader1' })).toBe(0);
  });

  it('refuses a banned device', async () => {
    await BannedDevice.create({ deviceId: 'dev-banned', reason: 'evasion' });
    const res = await register(
      { accountName: 'evader2', email: 'evader2@x.test', password: PASSWORD },
      jwtTools, CLEAN_IP, 'dev-banned',
    ) as Res;
    expect(res.code).toBe('device_banned');
    expect(await User.countDocuments({ accountName: 'evader2' })).toBe(0);
  });

  it('refuses an IP last seen on an actively banned account', async () => {
    // The ban-evasion heuristic: no BannedIp row needed, just a banned user
    // whose lastIp matches.
    await mkUser({ banned: true, lastIp: '203.0.113.21' });
    const res = await register(
      { accountName: 'evader3', email: 'evader3@x.test', password: PASSWORD },
      jwtTools, '203.0.113.21', 'dev-y',
    ) as Res;
    expect(res.code).toBe('ip_linked');
  });

  it('allows an IP last seen on a user whose ban has been lifted', async () => {
    await mkUser({ banned: false, lastIp: '203.0.113.22' });
    const res = await register(
      { accountName: 'fine1', email: 'fine1@x.test', password: PASSWORD },
      jwtTools, '203.0.113.22', 'dev-z',
    ) as Res;
    expect(res.error).toBeUndefined();
  });

  it('does not disclose which field collided when the existing account is banned', async () => {
    // A banned user's email must not come back as `email_taken` — that would
    // confirm the account exists to whoever is probing.
    const existing = await mkUser({ banned: true });
    const res = await register(
      { accountName: 'other', email: existing.email, password: PASSWORD },
      jwtTools, CLEAN_IP, 'dev-q',
    ) as Res;
    expect(res.code).toBe('register_account_restricted');
    expect(res.status).toBe(403);
  });
});

describe('login — ban gates', () => {
  it('signs in a clean user', async () => {
    const u = await mkUser();
    const res = await doLogin(u.accountName, PASSWORD);
    expect(res.error).toBeUndefined();
    expect(res.accessToken).toBeTruthy();
  });

  it('refuses a banned IP', async () => {
    const u = await mkUser();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await doLogin(u.accountName, PASSWORD, BAD_IP);
    expect(res.code).toBe('ip_banned_login');
  });

  it('refuses a banned device', async () => {
    const u = await mkUser();
    await BannedDevice.create({ deviceId: 'dev-banned', reason: 'evasion' });
    const res = await doLogin(u.accountName, PASSWORD, CLEAN_IP, 'dev-banned');
    expect(res.code).toBe('device_banned');
  });

  it('checks the network ban before the password, so a banned IP learns nothing from a wrong guess', async () => {
    const u = await mkUser();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await doLogin(u.accountName, 'wrong-password', BAD_IP);
    expect(res.code).toBe('ip_banned_login');
  });

  it('issues tokens to a banned user on purpose, so the client can render the appeal form', async () => {
    const u = await mkUser({ banned: true });
    const res = await doLogin(u.accountName, PASSWORD);
    expect(res.error).toBeUndefined();
    expect(res.accessToken).toBeTruthy();
  });

  it('clears an expired ban at login', async () => {
    const u = await mkUser({ banned: true, banUntil: new Date(Date.now() - 1000) });
    await doLogin(u.accountName, PASSWORD);
    const doc = await User.findById(u.id).lean<{ ban?: { active?: boolean } }>();
    expect(doc?.ban?.active).toBe(false);
  });

  it('refuses a soft-deleted account', async () => {
    const u = await mkUser({ isDeleted: true });
    const res = await doLogin(u.accountName, PASSWORD);
    expect(res.code).toBe('account_deleted');
  });

  it('rejects a wrong password with a generic error', async () => {
    const u = await mkUser();
    const res = await doLogin(u.accountName, 'wrong-password');
    expect(res.code).toBe('invalid_credentials');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown identifier with the same generic error', async () => {
    const res = await doLogin('nobody-here', PASSWORD);
    expect(res.code).toBe('invalid_credentials');
  });

  /**
   * FINDING E — the superadmin network-ban bypass is evaluated before
   * authentication.
   *
   * auth.service.ts:274 computes `isSuperadmin` from the *claimed* identifier,
   * then skips the IP and device ban checks on that basis — before any password
   * is verified. No credential is granted, so this is not an auth bypass, but
   * it does mean an IP-banned actor who knows (or guesses) the superadmin's
   * account name is no longer network-blocked from probing login. The bypass
   * itself is legitimate (a superadmin must not be able to lock themselves out
   * of their own instance); it should simply be applied *after* the credential
   * check rather than before it.
   *
   * Remove the `.fails` marker once the bypass moves below verifyPassword.
   */
  it.fails('should still refuse a banned IP when the claimed identifier is a superadmin (FINDING E)', async () => {
    const su = await mkUser({ role: 'superadmin' });
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await doLogin(su.accountName, 'wrong-password', BAD_IP);
    expect(res.code).toBe('ip_banned_login');
  });
});

describe('checkIdentifier — ban gates', () => {
  it('refuses a banned IP', async () => {
    const u = await mkUser();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await checkIdentifier(u.accountName, BAD_IP, 'dev-ok') as Res;
    expect(res.code).toBe('ip_banned_login');
  });

  it('reports a clean account as existing', async () => {
    const u = await mkUser();
    const res = await checkIdentifier(u.accountName, CLEAN_IP, 'dev-ok') as Res & { exists?: boolean };
    expect(res.exists).toBe(true);
  });

  /**
   * FINDING E, second surface — same pre-auth bypass, but here it is an
   * unauthenticated oracle: from a banned IP, naming the superadmin returns
   * `exists`, `accountName`, `avatarUrl` and the passkey count.
   */
  it.fails('should refuse a banned IP probing a superadmin identifier (FINDING E)', async () => {
    const su = await mkUser({ role: 'superadmin' });
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await checkIdentifier(su.accountName, BAD_IP, 'dev-ok') as Res;
    expect(res.code).toBe('ip_banned_login');
  });
});

describe('refresh — ban gates and rotation', () => {
  async function session(ip = CLEAN_IP, deviceId = 'dev-ok'): Promise<{ user: Made; refreshToken: string }> {
    const user = await mkUser();
    const res = await doLogin(user.accountName, PASSWORD, ip, deviceId);
    return { user, refreshToken: res.refreshToken as string };
  }

  // A refresh token's only distinguishing fields are `iat`/`exp`, which are
  // second-granular (see FINDING I). Cross a second boundary when a test needs
  // the rotated token to actually differ from the original.
  const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

  it('rotates a valid refresh token', async () => {
    const { refreshToken } = await session();
    const res = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.error).toBeUndefined();
    expect(res.refreshToken).toBeTruthy();
  });

  /**
   * FINDING I — rotation can re-mint the identical token.
   *
   * signRefresh signs `{ sub, accountName, role, familyId }` plus jwt's own
   * `iat`/`exp`, which have one-second resolution and no nonce. Two issuances
   * for the same session inside the same second therefore produce the same
   * string, so `session.refreshTokenHash` and `previousRefreshTokenHash` both
   * end up holding that one value and the rotation is a no-op: a token captured
   * before the refresh is still the live token after it.
   *
   * The client refreshes at 75% of a 15–30 minute lifetime, so in normal
   * operation this only lands during rapid or concurrent refreshes — but
   * "rotation sometimes doesn't rotate" is not a property a session system
   * should have. Fix: add a random `jti` to the refresh payload so every
   * issuance is unique.
   *
   * Remove the `.fails` marker once refresh tokens carry a nonce.
   */
  it.fails('should issue a distinct token on every rotation (FINDING I)', async () => {
    const { refreshToken } = await session();
    const res = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.refreshToken).not.toBe(refreshToken);
  });

  it('refuses a banned device', async () => {
    const { refreshToken } = await session();
    await BannedDevice.create({ deviceId: 'dev-ok', reason: 'evasion' });
    const res = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.code).toBe('device_banned');
  });

  it('refuses a soft-deleted account', async () => {
    const { user, refreshToken } = await session();
    await User.updateOne({ _id: user.id }, { $set: { isDeleted: true } });
    const res = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.code).toBe('user_not_found');
  });

  it('honours the grace window for a token rotated moments ago', async () => {
    const { refreshToken } = await session();
    await nextSecond();
    const rotated = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(rotated.refreshToken).not.toBe(refreshToken); // genuinely rotated

    // The previous token stays usable for 60s so concurrent in-flight refreshes
    // from the same client are not mistaken for theft.
    const res = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.error).toBeUndefined();
  });

  it('invalidates the whole session family when a token is replayed past the grace window', async () => {
    const { user, refreshToken } = await session();
    await nextSecond();
    const rotated = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Expire the grace window, then replay the original.
    await Session.updateMany({ userId: user.id }, { $set: { previousRefreshTokenExpiry: new Date(Date.now() - 1000) } });

    const replay = await refresh(refreshToken, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(replay.code).toBe('token_reused');

    const sessions = await Session.find({ userId: user.id }).lean<{ isValid?: boolean }[]>();
    expect(sessions.every((s) => s.isValid === false)).toBe(true);

    // The legitimately rotated token is dead too — breach detection is
    // intentionally blunt.
    const after = await refresh(rotated.refreshToken as string, jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(after.code).toBe('token_reused');
  });

  it('rejects a garbage token', async () => {
    const res = await refresh('not-a-jwt', jwtTools, CLEAN_IP, 'dev-ok') as Res;
    expect(res.code).toBe('token_expired');
  });

  /**
   * FINDING A, credential-path half — refresh checks the device ban but never
   * the IP ban (auth.service.ts:426 calls checkDevice only).
   *
   * Combined with the GraphQL context gap, an IP-banned user with a live
   * session rotates tokens indefinitely and keeps full use of the data graph.
   * The IP ban only ever stops a *new* login.
   *
   * Remove the `.fails` marker once refresh checks BannedIp.
   */
  it.fails('should refuse a banned IP on refresh (FINDING A)', async () => {
    const { refreshToken } = await session();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await refresh(refreshToken, jwtTools, BAD_IP, 'dev-ok') as Res;
    expect(res.status).toBe(403);
  });
});
