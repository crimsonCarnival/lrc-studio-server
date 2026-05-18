import User from '../../db/user.model.js';
import Project from '../../modules/projects/project.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';

export const userResolvers = {
  Query: {
    me: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      const user = await User.findById(context.userId);
      return user?.toPublic();
    },
  },

  Mutation: {
    updateProfile: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const user = await User.findById(context.userId);
      if (!user) throw new Error('User not found');

      const { username, email, bio, avatarUrl } = input;

      if (username && username !== user.username) {
        const existing = await User.findOne({ username: username.trim() });
        if (existing) throw new Error('Username already taken');
        user.username = username.trim();
      }

      if (email && email.toLowerCase().trim() !== user.email) {
        const existing = await User.findOne({ email: email.toLowerCase().trim() });
        if (existing) throw new Error('Email already in use');
        user.email = email.toLowerCase().trim();
      }

      if (bio !== undefined) {
        user.bio = bio.trim().slice(0, 160);
      }

      if (avatarUrl !== undefined) {
        user.avatarUrl = avatarUrl;
      }

      await user.save();
      return user.toPublic();
    },
  },

  User: {
    id: (user: any) => user._id?.toString() ?? user.id,
    createdAt: (user: any) => user.createdAt ? new Date(user.createdAt).toISOString() : null,
    projects: async (user: any) => Project.find({ userId: user._id ?? user.id }),
    uploads: async (user: any) => Upload.find({ userId: user._id ?? user.id }),
    settings: async (user: any) => Settings.findOne({ userId: user._id ?? user.id }),
  },
};
