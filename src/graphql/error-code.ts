/**
 * Machine-readable `extensions.code` for a resolver error.
 *
 * Mercurius answers HTTP 200 for resolver errors (it only maps `statusCode`, which
 * no resolver sets), so an HTTP-style `status` on a thrown error never reaches the
 * client. Resolvers throw in several historical styles — `new Error('Unauthorized')`,
 * `{ status: 403 }`, playlist's `new Error('forbidden')` — and this turns all of them
 * into one code the client can branch on. An explicit `extensions.code` always wins.
 */
const STATUS_CODES: Record<number, string> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

const MESSAGE_CODES: Record<string, string> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
};

export function deriveErrorCode(original: unknown, { banned = false }: { banned?: boolean } = {}): string | undefined {
  const code = codeOf(original);
  return code === 'unauthorized' && banned ? 'banned' : code;
}

function codeOf(original: unknown): string | undefined {
  if (!original || typeof original !== 'object') return undefined;
  const err = original as { extensions?: { code?: unknown }; status?: unknown; message?: unknown };
  if (typeof err.extensions?.code === 'string') return err.extensions.code;
  if (typeof err.status === 'number' && STATUS_CODES[err.status]) return STATUS_CODES[err.status];
  if (typeof err.message === 'string') return MESSAGE_CODES[err.message.toLowerCase()];
  return undefined;
}
