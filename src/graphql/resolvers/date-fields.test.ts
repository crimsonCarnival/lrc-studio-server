/**
 * The `String` scalar serializes a JS Date as epoch-ms ("1793491200000"), which the
 * client's `new Date(value)` cannot parse. Date-like fields must reach the wire as ISO.
 */
import { describe, it, expect } from 'vitest';
import { buildSchema, execute, parse, isObjectType, getNamedType, type GraphQLFieldResolver } from 'graphql';
import { schemaString } from '../schema/index.js';
import { resolvers } from '../resolvers.js';

const DATE_FIELD = /(At|Until|Date)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ResolverMap = Record<string, Record<string, GraphQLFieldResolver<unknown, unknown>>>;

/** Real SDL with the real type resolvers attached; root fields come from rootValue. */
function executableSchema() {
  const schema = buildSchema(schemaString);
  for (const [typeName, fields] of Object.entries(resolvers as unknown as ResolverMap)) {
    if (typeName === 'Query' || typeName === 'Mutation') continue;
    const type = schema.getType(typeName);
    if (!isObjectType(type)) continue;
    for (const [fieldName, resolve] of Object.entries(fields)) {
      const field = type.getFields()[fieldName];
      if (field && typeof resolve === 'function') field.resolve = resolve;
    }
  }
  return schema;
}

describe('date fields serialize as ISO strings', () => {
  const at = new Date('2026-11-01T12:34:56.789Z');

  it('me: the Date values toPublic() returns reach the client as ISO', async () => {
    // Shape of User#toPublic() for a banned user with a pending appeal.
    const me = {
      id: 'u1', accountName: 'a', isVerified: true, role: 'user', permissions: [], hasPassword: true,
      createdAt: at, passwordChangedAt: at, lastAccountNameChangedAt: at,
      ban: { active: true, reason: 'r', until: at },
      appeal: { text: 't', status: 'pending', submittedAt: at, resolvedAt: at },
    };
    const result = await execute({
      schema: executableSchema(),
      document: parse(`{ me {
        createdAt passwordChangedAt lastAccountNameChangedAt
        ban { until } appeal { submittedAt resolvedAt }
      } }`),
      rootValue: { me },
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ me: {
      createdAt: at.toISOString(), passwordChangedAt: at.toISOString(), lastAccountNameChangedAt: at.toISOString(),
      ban: { until: at.toISOString() }, appeal: { submittedAt: at.toISOString(), resolvedAt: at.toISOString() },
    } });
  });

  it('keeps null for an unset date instead of inventing one', async () => {
    const result = await execute({
      schema: executableSchema(),
      document: parse('{ me { passwordChangedAt lastAccountNameChangedAt ban { until } } }'),
      rootValue: { me: { id: 'u1', passwordChangedAt: null, lastAccountNameChangedAt: null, ban: { active: false } } },
      contextValue: {},
    });
    expect(result.data).toEqual({ me: { passwordChangedAt: null, lastAccountNameChangedAt: null, ban: { until: null } } });
  });

  it('Project.contentUpdatedAt is ISO', async () => {
    const resolve = (resolvers as unknown as ResolverMap).Project.contentUpdatedAt;
    expect(resolve({ contentUpdatedAt: at }, {}, {}, undefined as never)).toBe(at.toISOString());
  });

  // Guard: every date-like String field on the types touched above has a converting resolver,
  // so a future field added to these types without one fails here instead of in the browser.
  it.each(['User', 'UserBan', 'UserAppeal', 'Project', 'Lyrics', 'Upload'])('%s: every date-like field converts', async (typeName) => {
    const type = buildSchema(schemaString).getType(typeName);
    if (!isObjectType(type)) throw new Error(`${typeName} is not an object type`);
    const typeResolvers = (resolvers as unknown as ResolverMap)[typeName] ?? {};
    const unconverted: string[] = [];
    for (const f of Object.values(type.getFields())) {
      if (!DATE_FIELD.test(f.name) || getNamedType(f.type).name !== 'String') continue;
      const resolve = typeResolvers[f.name];
      // Viewed by its own owner, so privacy-gated fields still return their value.
      const out = typeof resolve === 'function'
        ? await resolve({ _id: 'self', id: 'self', [f.name]: at }, {}, { userId: 'self' }, undefined as never)
        : undefined;
      if (!(typeof out === 'string' && ISO.test(out))) unconverted.push(f.name);
    }
    expect(unconverted).toEqual([]);
  });
});
