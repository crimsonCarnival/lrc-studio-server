// Vitest setup file

// `config/env.ts` fails closed for anything but NODE_ENV=development, and
// vitest runs as NODE_ENV=test — so any test that imports a module reaching
// getEnv() (the auth plugin, the OG module, …) needs these present before the
// first import. Values are throwaway; nothing here reaches a real service.
process.env.CORS_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://localhost:27017/lrc-studio-test';
process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.COOKIE_SECRET ??= 'test-cookie-secret';
// Not optional in practice, despite the `?` on Env: signAccess/signRefresh pass
// `issuer`/`audience` to jwt.sign unconditionally, and jsonwebtoken rejects an
// explicit `undefined` with `"issuer" must be a string`. Unset, every token
// signing call throws.
process.env.JWT_ISSUER ??= 'lrc-studio-test';
process.env.JWT_AUDIENCE ??= 'lrc-studio-test-client';
