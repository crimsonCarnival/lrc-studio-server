import type { FastifyReply, FastifyRequest } from 'fastify';

type HandledError = Error & {
  validation?: { keyword: string; instancePath?: string; params?: { missingProperty?: string } }[];
  /** Which part of the request failed: 'body' | 'headers' | 'querystring' | 'params'. */
  validationContext?: string;
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
 * server.ts, auth.routes.ts, and the since-retired settings.routes.ts.
 *
 * Mongoose ValidationError → 422 (syntactically valid request, semantically
 * invalid data), not 400 (malformed request), which is what the old
 * settings.routes.ts mapped it to.
 */
export function handleFastifyError(error: HandledError, request: FastifyRequest, reply: FastifyReply): void {
  if (error.validation) {
    const missing = error.validation.find((v) => v.keyword === 'required' && v.params?.missingProperty)
      ?.params?.missingProperty;
    if (missing && error.validationContext === 'headers') {
      reply.code(400).send({ error: 'Missing required header: ' + missing });
      return;
    }
    // A missing body/query field used to be reported as a missing "header" too. `field` names
    // the offending field (a missing one, or the path of the first invalid one, e.g. `lines`).
    const field = missing ?? error.validation[0]?.instancePath?.replace(/^\//, '').split('/')[0];
    reply.code(400).send(field ? { error: 'validation_error', field } : { error: 'validation_error' });
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
