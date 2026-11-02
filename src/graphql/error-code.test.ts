import { describe, it, expect } from 'vitest';
import { deriveErrorCode } from './error-code.js';

describe('deriveErrorCode', () => {
  it('keeps an explicit extensions.code', () => {
    expect(deriveErrorCode(Object.assign(new Error('x'), { extensions: { code: 'already_forked' }, status: 409 }))).toBe('already_forked');
  });

  it('maps an HTTP-style status the transport would otherwise drop', () => {
    expect(deriveErrorCode(Object.assign(new Error('Token expired'), { status: 401 }))).toBe('unauthorized');
    expect(deriveErrorCode(Object.assign(new Error('Not authorized to edit this project'), { status: 403 }))).toBe('forbidden');
    expect(deriveErrorCode(Object.assign(new Error('Project not found'), { status: 404 }))).toBe('not_found');
  });

  it('maps the bare-message throws used across resolvers', () => {
    expect(deriveErrorCode(new Error('Unauthorized'))).toBe('unauthorized');
    expect(deriveErrorCode(new Error('UNAUTHORIZED'))).toBe('unauthorized');
    expect(deriveErrorCode(new Error('forbidden'))).toBe('forbidden');
    expect(deriveErrorCode(new Error('not_found'))).toBe('not_found');
  });

  it('reports an auth refusal to a banned caller as banned, not as an expired session', () => {
    expect(deriveErrorCode(new Error('Unauthorized'), { banned: true })).toBe('banned');
    expect(deriveErrorCode(Object.assign(new Error('x'), { status: 401 }), { banned: true })).toBe('banned');
    expect(deriveErrorCode(new Error('forbidden'), { banned: true })).toBe('forbidden');
  });

  it('leaves unknown errors without a code', () => {
    expect(deriveErrorCode(new Error('boom'))).toBeUndefined();
    expect(deriveErrorCode(undefined)).toBeUndefined();
  });
});
