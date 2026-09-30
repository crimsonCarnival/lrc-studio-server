/**
 * Replaces the unique+sparse index on `google.googleId` with a unique+partial one.
 *
 * Why: `sparse` only skips documents where the field is ABSENT. `google.googleId`
 * is declared with `default: null`, so the field is present-and-null on every
 * password account. A sparse unique index therefore admits exactly one null and
 * rejects every subsequent password registration with an E11000 duplicate key
 * error surfaced to the user as a 500.
 *
 * A partial index keyed on `$type: "string"` indexes only real Google ids, so any
 * number of null (non-Google) accounts coexist while duplicate links stay blocked.
 *
 * Dry run (default):  npx tsx scripts/fix-google-index.ts
 * Apply:              npx tsx scripts/fix-google-index.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const INDEX_NAME = 'google.googleId_1';
const KEY = { 'google.googleId': 1 } as const;
const PARTIAL = { 'google.googleId': { $type: 'string' } } as const;

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI!);
  const col = mongoose.connection.db!.collection('users');

  const before = (await col.indexes()).find((i) => i.name === INDEX_NAME);
  const counts = {
    total: await col.countDocuments({}),
    googleLinked: await col.countDocuments({ 'google.googleId': { $type: 'string' } }),
    nullOrAbsent: await col.countDocuments({ 'google.googleId': { $not: { $type: 'string' } } }),
  };
  console.log('current index:', JSON.stringify(before ?? null));
  console.log('counts:', JSON.stringify(counts));

  if (before?.partialFilterExpression) {
    console.log('Already a partial index — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Duplicate real Google ids would make the new unique index fail to build.
  const dupes = await col
    .aggregate([
      { $match: { 'google.googleId': { $type: 'string' } } },
      { $group: { _id: '$google.googleId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  if (dupes.length) {
    console.error('ABORT: duplicate google ids present, resolve first:', JSON.stringify(dupes));
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('duplicate google ids: none');

  if (!apply) {
    console.log('\nDRY RUN — would drop', INDEX_NAME, 'and recreate as unique + partial');
    console.log('partialFilterExpression:', JSON.stringify(PARTIAL));
    console.log('Re-run with --apply to execute.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nDropping', INDEX_NAME, '…');
  await col.dropIndex(INDEX_NAME);
  console.log('Recreating as unique + partial …');
  await col.createIndex(KEY, { unique: true, partialFilterExpression: PARTIAL, name: INDEX_NAME });

  const after = (await col.indexes()).find((i) => i.name === INDEX_NAME);
  console.log('new index:', JSON.stringify(after));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
