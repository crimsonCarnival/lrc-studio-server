import mongoose, { type ClientSession } from 'mongoose';

export class TransactionError extends Error {
  readonly code: string;
  readonly cause: unknown;
  readonly context: Record<string, unknown> | undefined;

  constructor(code: string, cause: unknown, context?: Record<string, unknown>) {
    super(code);
    this.name = 'TransactionError';
    this.code = code;
    this.cause = cause;
    this.context = context;
  }
}

export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(fn);
  } catch (err) {
    throw new TransactionError('transaction_rollback', err, context);
  } finally {
    await session.endSession();
  }
}
