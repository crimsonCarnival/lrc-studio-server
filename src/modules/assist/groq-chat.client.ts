// Shared Groq chat-completions client for every AI-assist feature. Errors are opaque
// codes only: upstream error text, reasoning text and the API key never leave here.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_TIMEOUT_MS = 20_000;

export type AssistErrorCode = 'assist_unavailable' | 'assist_upstream' | 'assist_daily_cap';

export class AssistError extends Error {
  code: AssistErrorCode;
  constructor(code: AssistErrorCode) {
    super(code);
    this.code = code;
  }
}

export type ChatMessage = { role: 'system' | 'user'; content: string };
export type JsonSchemaSpec = { name: string; schema: Record<string, unknown> };

export function assistModel(): string {
  return process.env.ASSIST_MODEL || DEFAULT_MODEL;
}

export function isAssistConfigured(): boolean {
  return !!process.env.GROQ_API_KEY;
}

export async function chatJson<T>(
  model: string,
  messages: ChatMessage[],
  jsonSchema: JsonSchemaSpec,
  opts: { validate: (v: unknown) => v is T; effort?: 'low' | 'medium' | 'high'; timeoutMs?: number },
): Promise<T> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AssistError('assist_unavailable');

  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema },
        },
        reasoning_effort: opts.effort ?? 'low',
        include_reasoning: false,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new AssistError('assist_upstream');
  }

  if (res.status === 401 || res.status === 403) throw new AssistError('assist_unavailable');
  if (!res.ok) throw new AssistError('assist_upstream');

  try {
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AssistError('assist_upstream');
    const parsed: unknown = JSON.parse(content);
    if (!opts.validate(parsed)) throw new AssistError('assist_upstream');
    return parsed;
  } catch {
    throw new AssistError('assist_upstream');
  }
}
