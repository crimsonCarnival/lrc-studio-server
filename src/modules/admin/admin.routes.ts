import type { FastifyInstance } from 'fastify';
import * as adminController from './admin.controller.js';
import {
  userIdParam,
  banUserSchema,
  shadowBanUserSchema,
  changeRoleSchema,
  blockIpSchema,
  blockDeviceSchema,
  listUsersSchema,
  listLogsSchema,
  idParam,
} from './admin.schema.js';

export default async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Blanket: must be staff (any permission). Per-route hooks enforce specifics.
  fastify.addHook('onRequest', fastify.requireStaff);

  const perm = fastify.requirePermission;
  const sudo = fastify.requireSudo;

  // Re-auth endpoints — issue the sudo grant. Staff-gated, not permission/sudo-gated.
  fastify.get('/sudo/factors', adminController.sudoFactors);
  fastify.post('/sudo', adminController.sudo);
  fastify.post('/sudo/passkey/options', adminController.sudoPasskeyOptions);
  fastify.post('/sudo/passkey/verify', adminController.sudoPasskeyVerify);

  // Read-only — gated by the matching view permission.
  fastify.get('/users', { preHandler: perm('users.view'), schema: { querystring: listUsersSchema.querystring } }, adminController.getUsers);
  fastify.get('/stats', { preHandler: perm('stats.view') }, adminController.getStats);
  fastify.get('/audit-logs', { preHandler: perm('audit.view'), schema: { querystring: listLogsSchema.querystring } }, adminController.getAuditLogs);
  fastify.get('/banned-ips', { preHandler: perm('network.block') }, adminController.getBannedIps);
  fastify.get('/banned-devices', { preHandler: perm('network.block') }, adminController.getBannedDevices);

  // Destructive — permission + a fresh sudo grant (see F24).
  fastify.post('/users/:id/ban', { preHandler: [perm('users.ban'), sudo], schema: banUserSchema }, adminController.banUser);
  fastify.post('/users/:id/unban', { preHandler: [perm('users.ban'), sudo], schema: { params: userIdParam } }, adminController.unbanUser);
  fastify.post('/users/:id/reject-appeal', { preHandler: [perm('users.ban'), sudo], schema: { params: userIdParam } }, adminController.rejectAppeal);
  fastify.post('/users/:id/shadowban',   { preHandler: [perm('users.shadowban'), sudo], schema: shadowBanUserSchema }, adminController.shadowBanUser);
  fastify.post('/users/:id/unshadowban', { preHandler: [perm('users.shadowban'), sudo], schema: { params: userIdParam } }, adminController.unshadowBanUser);
  fastify.post('/users/:id/role', { preHandler: [perm('users.role'), sudo], schema: changeRoleSchema }, adminController.changeRole);
  fastify.delete('/users/:id', { preHandler: [perm('users.delete'), sudo], schema: { params: userIdParam } }, adminController.deleteUser);
  fastify.post('/users/:id/reactivate', { preHandler: [perm('users.delete'), sudo], schema: { params: userIdParam } }, adminController.reactivateUser);

  fastify.post('/banned-ips', { preHandler: [perm('network.block'), sudo], schema: blockIpSchema }, adminController.blockIp);
  fastify.delete('/banned-ips/:id', { preHandler: [perm('network.block'), sudo], schema: { params: idParam } }, adminController.unblockIp);

  fastify.post('/banned-devices', { preHandler: [perm('network.block'), sudo], schema: blockDeviceSchema }, adminController.blockDevice);
  fastify.delete('/banned-devices/:id', { preHandler: [perm('network.block'), sudo], schema: { params: idParam } }, adminController.unblockDevice);

  fastify.post('/xp', { preHandler: [perm('xp.adjust'), sudo] }, adminController.adjustXP);
}
