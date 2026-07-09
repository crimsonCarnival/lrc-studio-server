import type { FastifyReply, FastifyRequest } from 'fastify';

type HandledError = Error & {
  validation?: { keyword: string; params?: { missingProperty?: string } }[];
  statusCode?: number;
  name?: string;
};

// Body message for thrown errors that only set `.statusCode` (e.g. the F7
// ownership check, assertValidLineTiming) with no explicit `.message`-driven
// body. Covers every code catalogued during the HTTP status audit, even ones
// with no current call site — keeps this map from needing an edit each time
// a new thrown status is wired up at a call site.
const STATUS_MESSAGES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  422: 'validation_error',
  423: 'locked',
  429: 'too_many_requests',
  451: 'unavailable_for_legal_reasons',
  500: 'server_error',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
};

/**
 * Shared Fastify error handler. Previously duplicated (and drifting) across
 * server.ts, auth.routes.ts, and settings.routes.ts.
 *
 * Mongoose ValidationError → 422 (syntactically valid request, semantically
 * invalid data), not 400 (malformed request) — settings.routes.ts used to map
 * it to 400.
 */
export function handleFastifyError(error: HandledError, request: FastifyRequest, reply: FastifyReply): void {
  if (error.validation) {
    const missingHeaders = error.validation.filter(
      (v) => v.keyword === 'required' && v.params?.missingProperty
    );
    if (missingHeaders.length > 0) {
      reply.code(400).send({ error: 'Missing required header: ' + missingHeaders[0].params?.missingProperty });
      return;
    }
    reply.code(400).send({ error: 'validation_error' });
    return;
  }
  if (error.name === 'ValidationError') {
    reply.code(422).send({ error: 'validation_error' });
    return;
  }
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    request.log.error({ err: error, url: request.url, method: request.method }, 'Unhandled error');
  }
  reply.code(statusCode).send({ error: STATUS_MESSAGES[statusCode] ?? 'server_error' });
}
