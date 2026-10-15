import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import { flattenSettingsUpdate } from '../../modules/settings/settings.update.js';

export const settingsResolvers = {
  ExportSettings: {
    // Never stored for most users; readers always get a real boolean.
    includeFeaturedInTitle: (exportSettings: { includeFeaturedInTitle?: boolean | null } | null) =>
      exportSettings?.includeFeaturedInTitle === true,
  },

  Query: {
    settings: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) return null;
      return Settings.findOne({ userId: context.userId });
    },
  },

  Mutation: {
    updateSettings: async (_root: unknown, { input }: { input: Record<string, unknown> }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      return Settings.findOneAndUpdate(
        { userId: context.userId },
        // Per-field paths: a partial group (e.g. only `export.stripEmptyLines`) must not erase its siblings.
        { $set: flattenSettingsUpdate(input) },
        { new: true, upsert: true }
      );
    },

    resetSettings: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await Settings.deleteOne({ userId: context.userId });
      return true;
    },
  },
};
