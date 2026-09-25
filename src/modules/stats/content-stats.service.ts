import mongoose from 'mongoose';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import User from '../../db/user.model.js';
import { getAddictionLevel } from './addiction-level.service.js';
import { getStreakView } from '../badges/badge.service.js';

export interface ContentStats {
  totalProjects: number;
  totalLines: number;
  syncedLines: number;
  completionPercentage: number;
  averageProjectCompletion: number;
  averageLinesPerProject: number;
  fullySyncedProjects: number;
  musicSyncedMinutes: number;
  musicSyncedSeconds: number;
  wordsTimestamped: number;
  karaokeLines: number;
  publicProjects: number;
  starsReceived: number;
  forksReceived: number;
  mostSyncedProject: { title: string; count: number } | null;
  largestProject: { title: string; count: number } | null;
  syncTrendPercentage: number;
  addictionId: string;
  addictionTitle: { en: string; es: string };
  currentStreak: number;
  longestStreak: number;
}

export async function getUserContentStats(userId: string): Promise<ContentStats> {
  const userId_ = new mongoose.Types.ObjectId(userId);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const user = await User.findById(userId_).lean();
  if (!user) throw new Error('User not found');

  const projects = await Project.find({ userId: userId_ }).lean();
  const totalProjects = projects.length;
  const publicProjects = projects.filter(p => p.public).length;

  const musicSyncedMinutes = user.stats?.minutesSynced ?? 0;
  const musicSyncedSeconds = user.stats?.secondsSynced ?? 0;
  const wordsTimestamped   = user.stats?.wordsSynced ?? 0;
  const karaokeLines_      = user.stats?.karaokeLines ?? 0;
  const cachedSyncedLines  = user.stats?.syncedLines ?? null;  // use cache if available
  const starsReceived      = user.social?.totalStarsReceived ?? 0;

  // Single source of truth for streaks: the stored authoring streak (see
  // updateStreak), read through getStreakView so a lapsed streak shows 0.
  // The activity heatmap counts social events and must not drive this number.
  const { current: currentStreak, longest: longestStreak } = getStreakView(user.streak);

  if (totalProjects === 0) {
    const { id: addictionId, title: addictionTitle } = await getAddictionLevel({
      syncedLines: 0,
      karaokeLines: karaokeLines_,
      musicSyncedMinutes,
      publicProjects,
      starsReceived,
      wordsTimestamped,
      totalProjects: 0,
    });
    return {
      totalProjects: 0,
      totalLines: 0,
      syncedLines: 0,
      completionPercentage: 0,
      averageProjectCompletion: 0,
      averageLinesPerProject: 0,
      fullySyncedProjects: 0,
      musicSyncedMinutes,
      musicSyncedSeconds,
      wordsTimestamped,
      karaokeLines: karaokeLines_,
      publicProjects,
      starsReceived,
      forksReceived: user.social?.totalForksReceived ?? 0,
      mostSyncedProject: null,
      largestProject: null,
      syncTrendPercentage: 0,
      addictionId,
      addictionTitle,
      currentStreak,
      longestStreak,
    };
  }

  const publicIds = projects.map(p => p.publicId);

  const lyrics = await Lyrics.find({ publicId: { $in: publicIds } }).lean();
  const lyricsBypublicId = new Map(lyrics.map(l => [l.publicId, l]));

  let totalLines = 0;
  let localSyncedLines = 0;
  let fullySyncedProjects = 0;
  let completionSum = 0;
  let projectsWithLines = 0;
  let mostSyncedProject: { publicId: string; title: string; syncedLines: number } | null = null;
  let largestProject: { publicId: string; title: string; totalLines: number } | null = null;

  for (const project of projects) {
    const lyric = lyricsBypublicId.get(project.publicId);
    if (!lyric) continue;

    const projectTotalLines = countTotalLines(lyric);
    const projectSyncedLines = countSyncedLines(lyric);

    totalLines += projectTotalLines;
    localSyncedLines += projectSyncedLines;

    if (projectTotalLines > 0 && projectSyncedLines === projectTotalLines) {
      fullySyncedProjects++;
    }

    if (projectTotalLines > 0) {
      completionSum += projectSyncedLines / projectTotalLines;
      projectsWithLines++;
    }

    if (!mostSyncedProject || projectSyncedLines > mostSyncedProject.syncedLines) {
      mostSyncedProject = {
        publicId: project.publicId,
        title: project.title ?? 'Untitled',
        syncedLines: projectSyncedLines,
      };
    }

    if (!largestProject || projectTotalLines > largestProject.totalLines) {
      largestProject = {
        publicId: project.publicId,
        title: project.title ?? 'Untitled',
        totalLines: projectTotalLines,
      };
    }
  }

  // Prefer the pre-computed cached value (which also counts karaoke-synced lines);
  // fall back to the locally computed count if the cache hasn't been populated yet.
  const syncedLines = cachedSyncedLines ?? localSyncedLines;

  const completionPercentage = totalLines > 0 ? Math.round((localSyncedLines / totalLines) * 100) : 0;
  const averageProjectCompletion = projectsWithLines > 0 ? Math.round((completionSum / projectsWithLines) * 100) : 0;
  const averageLinesPerProject = totalProjects > 0 ? Math.round(totalLines / totalProjects) : 0;

  // Sync trend: last 30 days vs previous 30 days
  const recent30 = projects.filter(p => p.createdAt && new Date(p.createdAt) >= thirtyDaysAgo).length;
  const previous30 = projects.filter(
    p => p.createdAt && new Date(p.createdAt) >= sixtyDaysAgo && new Date(p.createdAt) < thirtyDaysAgo
  ).length;
  const syncTrendPercentage = previous30 > 0 ? Math.round(((recent30 - previous30) / previous30) * 100) : 0;

  const { id: addictionId, title: addictionTitle } = await getAddictionLevel({
    syncedLines,
    karaokeLines: karaokeLines_,
    musicSyncedMinutes,
    publicProjects,
    starsReceived,
    wordsTimestamped,
    totalProjects,
  });


  return {
    totalProjects,
    totalLines,
    syncedLines,
    completionPercentage,
    averageProjectCompletion,
    averageLinesPerProject,
    fullySyncedProjects,
    musicSyncedMinutes,
    musicSyncedSeconds,
    wordsTimestamped,
    karaokeLines: karaokeLines_,
    publicProjects,
    starsReceived,
    forksReceived: user.social?.totalForksReceived ?? 0,
    mostSyncedProject: mostSyncedProject
      ? { title: mostSyncedProject.title, count: mostSyncedProject.syncedLines }
      : null,
    largestProject: largestProject
      ? { title: largestProject.title, count: largestProject.totalLines }
      : null,
    syncTrendPercentage,
    addictionId,
    addictionTitle,
    currentStreak,
    longestStreak,
  };
}

interface LyricShape {
  sections?: Array<{ lines?: Array<{ timestamp?: number | null }> }>;
}

function countTotalLines(lyric: LyricShape): number {
  let count = 0;
  for (const section of lyric.sections ?? []) {
    count += (section.lines ?? []).length;
  }
  return count;
}

function countSyncedLines(lyric: LyricShape): number {
  let count = 0;
  for (const section of lyric.sections ?? []) {
    for (const line of section.lines ?? []) {
      if (line.timestamp != null) {
        count++;
      }
    }
  }
  return count;
}
