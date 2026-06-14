import type { FastifyInstance } from 'fastify';
import * as adminController from './admin.controller.js';
import {
  userIdParam,
  banUserSchema,
  changeRoleSchema,
  blockIpSchema,
  blockDeviceSchema,
  listUsersSchema,
  listLogsSchema,
  idParam,
} from './admin.schema.js';

export default async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.requireAdmin);

  // Destructive routes additionally require a fresh sudo grant (see F24).
  const sudo = { preHandler: fastify.requireSudo };

  // Re-auth endpoints — issue the sudo grant. Admin-gated, but not sudo-gated.
  fastify.get('/sudo/factors', adminController.sudoFactors);
  fastify.post('/sudo', adminController.sudo);
  fastify.post('/sudo/passkey/options', adminController.sudoPasskeyOptions);
  fastify.post('/sudo/passkey/verify', adminController.sudoPasskeyVerify);

  // Read-only — admin auth is sufficient.
  fastify.get('/users', { schema: { querystring: listUsersSchema.querystring } }, adminController.getUsers);
  fastify.get('/stats', adminController.getStats);
  fastify.get('/audit-logs', { schema: { querystring: listLogsSchema.querystring } }, adminController.getAuditLogs);
  fastify.get('/banned-ips', adminController.getBannedIps);
  fastify.get('/banned-devices', adminController.getBannedDevices);

  // Destructive — require sudo.
  fastify.post('/users/:id/ban', { ...sudo, schema: banUserSchema }, adminController.banUser);
  fastify.post('/users/:id/unban', { ...sudo, schema: { params: userIdParam } }, adminController.unbanUser);
  fastify.post('/users/:id/reject-appeal', { ...sudo, schema: { params: userIdParam } }, adminController.rejectAppeal);
  fastify.post('/users/:id/role', { ...sudo, schema: changeRoleSchema }, adminController.changeRole);
  fastify.delete('/users/:id', { ...sudo, schema: { params: userIdParam } }, adminController.deleteUser);
  fastify.post('/users/:id/reactivate', { ...sudo, schema: { params: userIdParam } }, adminController.reactivateUser);

  fastify.post('/banned-ips', { ...sudo, schema: blockIpSchema }, adminController.blockIp);
  fastify.delete('/banned-ips/:id', { ...sudo, schema: { params: idParam } }, adminController.unblockIp);

  fastify.post('/banned-devices', { ...sudo, schema: blockDeviceSchema }, adminController.blockDevice);
  fastify.delete('/banned-devices/:id', { ...sudo, schema: { params: idParam } }, adminController.unblockDevice);

  fastify.post('/xp', sudo, adminController.adjustXP);
}