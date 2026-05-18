import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';

export const settingsResolvers = {
  Query: {
    settings: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      return Settings.findOne({ userId: context.userId });
    },
  },

  Mutation: {
    updateSettings: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      return Settings.findOneAndUpdate(
        { userId: context.userId },
        { $set: input },
        { new: true, upsert: true }
      );
    },

    resetSettings: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await Settings.deleteOne({ userId: context.userId });
      return true;
    },
  },
};
