/**
 * Unset the removed settings fields (editor.display.dualLine, showNextLine,
 * languageLayout and editor.nudge.coarse) from every settings document.
 *
 * The server already runs this on every startup (plugins/cron.ts), so this script is
 * only for a dry run against a database, or for running it without a deploy. Idempotent.
 *
 *   pnpm tsx scripts/unset-legacy-settings-fields.ts --dry-run
 *   pnpm tsx scripts/unset-legacy-settings-fields.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { unsetLegacySettingsFields } from '../src/modules/settings/legacy-settings-fields.migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const n = await unsetLegacySettingsFields({ dryRun: DRY_RUN });
  console.log(`${DRY_RUN ? '📝  Would clean' : '🧹  Cleaned'} ${n} settings document${n === 1 ? '' : 's'}`);
}

main()
  .catch((err) => {
    console.error('❌  Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
