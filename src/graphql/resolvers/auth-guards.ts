import { Context } from './context.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';

/**
 * Throws 401 if unauthenticated, 403 if the authenticated user is not an admin.
 * Returns the authenticated admin's userId (narrowed to a non-null string) so
 * callers can use it without re-checking for null.
 *
 * The GraphQL context only carries `userId` (set by optionalAuth), never a
 * trusted role, so the role is resolved from the DB and can't be spoofed by
 * the client. Use this for every admin-only resolver.
 */
export async function requireAdmin(context: Context): Promise<string> {
  if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const admin = await User.findById(context.userId).select('role').lean<IUser>();
  if (admin?.role !== 'admin') throw Object.assign(new Error('Forbidden'), { status: 403 });
  return context.userId;
}
