import type { FastifyReply, FastifyRequest } from 'fastify';
import { AssistError } from './groq-chat.client.js';
import { checkNames, type NameCheckInput } from './name-check.service.js';
import { splitTitle } from './title-split.service.js';
import { describeSong, type DescribeInput } from './describe.service.js';
import { romanizeLines } from './romanize.service.js';
import { labelSingers } from './singers.service.js';
import { runHeavy, getHeavyUsage, type HeavyUsage } from './assist-usage.service.js';

const STATUS = { assist_unavailable: 503, assist_upstream: 502, assist_daily_cap: 429 } as const;

const serializeUsage = (u: HeavyUsage) => ({ ...u, resetsAt: u.resetsAt.toISOString() });

/** Opaque error mapping: only the code reaches the client, never message or cause. */
function sendError(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof AssistError) {
    if (err.code === 'assist_daily_cap') {
      const resetsAt = (err as AssistError & { resetsAt?: Date }).resetsAt;
      return reply.code(429).send({ error: err.code, ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}) });
    }
    // AssistError carries no upstream HTTP status, so only the code is logged.
    request.log.warn({ code: err.code }, 'assist failed');
    return reply.code(STATUS[err.code]).send({ error: err.code });
  }
  request.log.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'assist unexpected error');
  return reply.code(502).send({ error: 'assist_upstream' });
}

const handler =
  <B>(run: (userId: string, body: B) => Promise<unknown>) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await run(request.userId as string, request.body as B));
    } catch (err) {
      return sendError(request, reply, err);
    }
  };

export const nameCheck = handler<NameCheckInput>(async (userId, b) => ({ suggestions: await checkNames(userId, b) }));
export const titleSplit = handler<{ title: string }>((_u, b) => splitTitle(b.title));
export const describe = handler<DescribeInput>((_u, b) => describeSong(b));
export const romanize = handler<{ lines: string[]; language?: string }>(async (userId, b) => {
  const { result, usage } = await runHeavy(userId, () => romanizeLines(b));
  return { lines: result, usage: serializeUsage(usage) };
});
export const singers = handler<{ lines: string[]; roster: string[] }>(async (userId, b) => {
  const { result, usage } = await runHeavy(userId, () => labelSingers(b));
  return { labels: result, usage: serializeUsage(usage) };
});

export async function usage(request: FastifyRequest, reply: FastifyReply) {
  try {
    return reply.send(serializeUsage(await getHeavyUsage(request.userId as string)));
  } catch (err) {
    return sendError(request, reply, err);
  }
}
