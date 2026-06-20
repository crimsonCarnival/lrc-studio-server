import UserActionLog from './userActionLog.model.js';

interface LogOptions {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  deviceId?: string;
}

/**
 * Fire-and-forget helper to log user actions.
 * Wraps the creation in a try-catch to prevent logging failures from crashing the main request.
 */
export async function logUserAction(options: LogOptions): Promise<void> {
  try {
    await UserActionLog.create({
      userId: options.userId || null,
      action: options.action,
      entityType: options.entityType,
      entityId: options.entityId,
      metadata: options.metadata || {},
      ip: options.ip || 'unknown',
      deviceId: options.deviceId || 'unknown',
    });
  } catch (err) {
    // In production, we should probably use a proper logger for this,
    // but we don't want a database issue to break the user's flow.
    console.error('Failed to write user action log:', err);
  }
}
