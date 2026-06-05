import mongoose from 'mongoose';
import Reaction, { ALLOWED_EMOJIS } from '../../db/reaction.model.js';
import { getIO } from '../../socket/socket.manager.js';
import Project from '../projects/project.model.js';
import User from '../../db/user.model.js';
import { upsertReaction } from '../notifications/notifications.service.js';

export interface ReactionSummary {
  emoji: string;
  count: number;
}

async function getReactionSummary(
  targetType: string,
  targetId: string
): Promise<ReactionSummary[]> {
  const rows = await Reaction.aggregate([
    { $match: { targetType, targetId } },
    { $group: { _id: '$emoji', count: { $sum: 1 } } },
  ]);
  return rows.map(r => ({ emoji: r._id as string, count: r.count as number }));
}

async function runToggle(
  userId: string,
  targetType: 'comment' | 'project',
  targetId: string,
  emoji: string
): Promise<boolean> {
  const existing = await Reaction.findOne({ userId, targetType, targetId });

  if (existing) {
    if (existing.emoji === emoji) {
      await existing.deleteOne();
      return false;
    }
    existing.emoji = emoji as typeof ALLOWED_EMOJIS[number];
    await existing.save();
    return true;
  }

  await Reaction.create({
    userId: new mongoose.Types.ObjectId(userId),
    targetType,
    targetId,
    emoji,
  });
  return true;
}

export async function reactToProject(
  projectId: string,
  userId: string,
  emoji: string
): Promise<{ reactions: ReactionSummary[]; myReaction: string | null }> {
  if (!(ALLOWED_EMOJIS as readonly string[]).includes(emoji)) throw new Error('Invalid emoji');

  const kept = await runToggle(userId, 'project', projectId, emoji);

  const reactions = await getReactionSummary('project', projectId);
  const myReaction = kept ? emoji : null;

  try {
    getIO()
      .to(`project:${projectId}`)
      .emit('reaction:update', { targetType: 'project', targetId: projectId, reactions });
  } catch {}

  if (kept) {
    try {
      const [project, actor] = await Promise.all([
        Project.findOne({ projectId }, 'userId title metadata').lean<{ userId: { toString(): string }; title?: string; metadata?: { songName?: string } }>(),
        User.findById(userId, 'accountName avatarUrl').lean<{ accountName: string; avatarUrl?: string | null }>(),
      ]);
      if (project && actor) {
        await upsertReaction({
          ownerId: project.userId.toString(),
          projectId,
          projectTitle: project.title || project.metadata?.songName || '',
          actorId: userId,
          actorAccountName: actor.accountName,
          actorAvatarUrl: actor.avatarUrl ?? null,
          emoji,
        });
      }
    } catch { /* notifications are non-critical */ }
  }

  return { reactions, myReaction };
}

export async function getProjectReactions(
  projectId: string,
  viewerUserId?: string
): Promise<{ reactions: ReactionSummary[]; myReaction: string | null }> {
  const reactions = await getReactionSummary('project', projectId);

  let myReaction: string | null = null;
  if (viewerUserId) {
    const r = await Reaction.findOne({
      userId: new mongoose.Types.ObjectId(viewerUserId),
      targetType: 'project',
      targetId: projectId,
    }).lean();
    myReaction = r?.emoji ?? null;
  }

  return { reactions, myReaction };
}
