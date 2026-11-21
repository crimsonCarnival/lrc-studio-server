import Settings from './settings.model.js';

/**
 * Settings fields the app no longer has: the dual-line preview (`dualLine`, its
 * `showNextLine` sub-option), the never-used `languageLayout`, and the never-used
 * coarse nudge step. The schema dropped them; this clears what older clients stored.
 */
export const LEGACY_SETTINGS_FIELDS = [
  'editor.display.dualLine',
  'editor.display.showNextLine',
  'editor.display.languageLayout',
  'editor.nudge.coarse',
] as const;

export interface LegacySettingsMigrationOptions {
  /** Count what would change without writing. */
  dryRun?: boolean;
}

/**
 * Unsets the legacy fields on every settings document that still has one, and returns
 * how many documents that was. Idempotent: once cleared, nothing matches, so it runs on
 * every startup and is a no-op after the first.
 */
export async function unsetLegacySettingsFields(opts: LegacySettingsMigrationOptions = {}): Promise<number> {
  const filter = { $or: LEGACY_SETTINGS_FIELDS.map((path) => ({ [path]: { $exists: true } })) };
  if (opts.dryRun) return Settings.collection.countDocuments(filter);
  const unset = Object.fromEntries(LEGACY_SETTINGS_FIELDS.map((path) => [path, '']));
  // Raw driver: the paths are no longer in the schema, so strict mode would drop them from a model update.
  const res = await Settings.collection.updateMany(filter, { $unset: unset });
  return res.modifiedCount;
}
