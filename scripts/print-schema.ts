/**
 * Writes the GraphQL SDL the server serves to the file given as argv[2], for client type
 * generation (the client's `pnpm codegen` runs this). Needs no database or env.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { schema } from '../src/graphql/schema.js';

const target = process.argv[2];
if (!target) throw new Error('usage: tsx scripts/print-schema.ts <output file>');
const out = resolve(target);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${schema}\n`);
