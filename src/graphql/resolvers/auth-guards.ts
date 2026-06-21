import { Context } from './context.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';
import { hasPermission, type Permission } from '../../shared/permissions.js';

/**
 * The GraphQL context only carries `userId` (set by optionalAuth), never a
 * trusted role or permission set, so authority is always resolved from the DB
 * and can't be spoofed by the client.
 */

export interface AuthedStaff {
  userId: string;
  role: string;
  permissions: string[];
}

/**
 * Throws 401 if unauthenticated, 403 if the authenticated user lacks `required`.
 * Returns the caller's id/role/permissions so resolvers can do further checks
 * (e.g. staff-protection ranking) without a second DB read.
 */
export async function requirePermission(context: Context, required: Permission): Promise<AuthedStaff> {
  if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const user = await User.findById(context.userId).select('role permissions').lean<IUser>();
  if (!user || !hasPermission(user.permissions, required)) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return { userId: context.userId, role: user.role, permissions: user.permissions ?? [] };
}
