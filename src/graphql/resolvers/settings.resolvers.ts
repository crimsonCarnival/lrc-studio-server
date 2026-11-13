import mercurius from 'mercurius';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import { flattenSettingsUpdate } from '../../modules/settings/settings.update.js';

/** Mirrors CUSTOM_THEME_MAX_LENGTH in the client's custom-theme.ts. */
const MAX_CUSTOM_THEME_LENGTH = 600;

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
      // findOneAndUpdate skips schema validation, so the stored JSON's size is checked here.
      const custom = (input.interface as { customTheme?: unknown } | undefined)?.customTheme;
      if (typeof custom === 'string' && custom.length > MAX_CUSTOM_THEME_LENGTH) {
        throw new mercurius.ErrorWithProps('custom_theme_too_large', { code: 'custom_theme_too_large' });
      }
      const tourShown = (input.interface as { editorTourShown?: unknown } | undefined)?.editorTourShown;
      if (tourShown != null && !(Number.isInteger(tourShown) && (tourShown as number) >= 0 && (tourShown as number) <= 1000)) {
        throw new mercurius.ErrorWithProps('invalid_tour_count', { code: 'invalid_tour_count' });
      }
      return Settings.findOneAndUpdate(
        { userId: context.userId },
        // Per-field paths: a partial group (e.g. only `export.stripEmptyLines`) must not erase its siblings.
        { $set: flattenSettingsUpdate(input) },
        { returnDocument: 'after', upsert: true }
      );
    },

    resetSettings: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await Settings.deleteOne({ userId: context.userId });
      return true;
    },
  },
};
