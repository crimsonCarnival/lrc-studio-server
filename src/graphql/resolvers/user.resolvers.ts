import User from '../../db/user.model.js';
import Project from '../../modules/projects/project.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import AccountNameHistory from '../../db/account-name-history.model.js';
import EmailHistory from '../../db/email-history.model.js';
import { sendVerification, resendVerification } from '../../modules/email-verification/email-verification.service.js';

export const userResolvers = {
  Query: {
    me: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      const user = await User.findById(context.userId);
      return user?.toPublic();
    },

    publicProfile: async (_root: any, { accountName }: { accountName: string }) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean();
      if (!user) return null;

      const projects = await Project.find({ userId: user._id, public: true })
        .sort({ starCount: -1 })
        .lean();

      const totalStarsReceived = projects.reduce((sum, p) => sum + (p.starCount ?? 0), 0);

      return {
        id: user._id.toString(),
        accountName: user.accountName,
        displayName: user.displayName ?? null,
        avatarUrl: user.avatarUrl ?? null,
        bio: user.bio ?? null,
        isVerified: user.isVerified ?? false,
        role: user.role ?? 'user',
        createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : new Date().toISOString(),
        projects,
        projectCount: projects.length,
        totalStarsReceived,
      };
    },
  },

  Mutation: {
    updateProfile: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const user = await User.findById(context.userId);
      if (!user) throw new Error('User not found');

      const { accountName, displayName, email, bio, avatarUrl } = input;

      if (accountName && accountName.toLowerCase().trim() !== user.accountName) {
        const COOLDOWN_DAYS = 7;
        if (user.lastAccountNameChangedAt) {
          const daysSince = (Date.now() - (user.lastAccountNameChangedAt as Date).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < COOLDOWN_DAYS) {
            const daysLeft = Math.ceil(COOLDOWN_DAYS - daysSince);
            throw Object.assign(new Error('accountName_change_cooldown'), { extensions: { code: 'accountName_change_cooldown', daysLeft, status: 429 } });
          }
        }
        const normalised = accountName.toLowerCase().trim();
        if (!/^[a-z0-9_-]{3,30}$/.test(normalised)) throw new Error('accountName_invalid');
        const existing = await User.findOne({ accountName: normalised });
        if (existing) throw new Error('Account name already taken');
        const previousAccountName = user.accountName;
        user.accountName = normalised;
        user.lastAccountNameChangedAt = new Date();
        AccountNameHistory.create({ userId: user._id, from: previousAccountName, to: normalised }).catch(() => {});
      }

      if (displayName !== undefined) {
        user.displayName = displayName ? displayName.trim().slice(0, 50) : null;
      }

      if (email && email.toLowerCase().trim() !== user.email && email.toLowerCase().trim() !== user.pendingEmail) {
        const normalised = email.toLowerCase().trim();
        const existing = await User.findOne({ $or: [{ email: normalised }, { pendingEmail: normalised }] });
        if (existing) throw new Error('Email already in use');
        user.pendingEmail = normalised;
        sendVerification(context.userId, normalised, 'email_change').catch(() => {});
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

    sendVerificationEmail: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await resendVerification(context.userId);
      return true;
    },
  },

  User: {
    id: (user: any) => user._id?.toString() ?? user.id,
    createdAt: (user: any) => user.createdAt ? new Date(user.createdAt).toISOString() : null,
    projects: async (user: any) => Project.find({ userId: user._id ?? user.id }),
    uploads: async (user: any) => Upload.find({ userId: user._id ?? user.id }),
    settings: async (user: any) => Settings.findOne({ userId: user._id ?? user.id }),

    previousAccountNames: (user: any) =>
      AccountNameHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 }).then(
        docs => docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }))
      ),

    accountNameChangeCount: (user: any) =>
      AccountNameHistory.countDocuments({ userId: user._id ?? user.id }),

    emailHistory: async (user: any, _args: any, context: Context) => {
      const selfId = (user._id ?? user.id)?.toString();
      if (context.userId === selfId) {
        const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
        return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
      }
      if (context.userId) {
        const requester = await User.findById(context.userId).select('role').lean();
        if ((requester as any)?.role === 'admin') {
          const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
          return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
        }
      }
      return [];
    },
  },
};
