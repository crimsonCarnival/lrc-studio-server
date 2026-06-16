import mongoose from 'mongoose';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import User from '../../db/user.model.js';

export interface ContentStats {
  totalProjects: number;
  totalLines: number;
  syncedLines: number;
  completionPercentage: number;
  averageProjectCompletion: number;
  averageLinesPerProject: number;
  fullySyncedProjects: number;
  musicSyncedMinutes: number;
  wordsTimestamped: number;
  karaokeLines: number;
  publicProjects: number;
  starsReceived: number;
  forksReceived: number;
  mostSyncedProject: { title: string; syncedLines: number } | null;
  largestProject: { title: string; totalLines: number } | null;
  syncTrendPercentage: number;
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

  if (totalProjects === 0) {
    return {
      totalProjects: 0,
      totalLines: 0,
      syncedLines: 0,
      completionPercentage: 0,
      averageProjectCompletion: 0,
      averageLinesPerProject: 0,
      fullySyncedProjects: 0,
      musicSyncedMinutes: user.stats?.minutesSynced ?? 0,
      wordsTimestamped: user.stats?.wordsSynced ?? 0,
      karaokeLines: user.stats?.karaokeLines ?? 0,
      publicProjects,
      starsReceived: user.social?.totalStarsReceived ?? 0,
      forksReceived: user.social?.totalForksReceived ?? 0,
      mostSyncedProject: null,
      largestProject: null,
      syncTrendPercentage: 0,
    };
  }

  const projectIds = projects.map(p => p.projectId);

  const lyrics = await Lyrics.find({ projectId: { $in: projectIds } }).lean();
  const lyricsByProjectId = new Map(lyrics.map(l => [l.projectId, l]));

  let totalLines = 0;
  let syncedLines = 0;
  let fullySyncedProjects = 0;
  let completionSum = 0;
  let projectsWithLines = 0;
  let mostSyncedProject: { projectId: string; title: string; syncedLines: number } | null = null;
  let largestProject: { projectId: string; title: string; totalLines: number } | null = null;

  for (const project of projects) {
    const lyric = lyricsByProjectId.get(project.projectId);
    if (!lyric) continue;

    const projectTotalLines = countTotalLines(lyric);
    const projectSyncedLines = countSyncedLines(lyric);

    totalLines += projectTotalLines;
    syncedLines += projectSyncedLines;

    if (projectTotalLines > 0 && projectSyncedLines === projectTotalLines) {
      fullySyncedProjects++;
    }

    if (projectTotalLines > 0) {
      completionSum += projectSyncedLines / projectTotalLines;
      projectsWithLines++;
    }

    if (!mostSyncedProject || projectSyncedLines > mostSyncedProject.syncedLines) {
      mostSyncedProject = {
        projectId: project.projectId,
        title: project.title ?? 'Untitled',
        syncedLines: projectSyncedLines,
      };
    }

    if (!largestProject || projectTotalLines > largestProject.totalLines) {
      largestProject = {
        projectId: project.projectId,
        title: project.title ?? 'Untitled',
        totalLines: projectTotalLines,
      };
    }
  }

  const completionPercentage = totalLines > 0 ? Math.round((syncedLines / totalLines) * 100) : 0;
  const averageProjectCompletion = projectsWithLines > 0 ? Math.round((completionSum / projectsWithLines) * 100) : 0;
  const averageLinesPerProject = totalProjects > 0 ? Math.round(totalLines / totalProjects) : 0;

  // Sync trend: last 30 days vs previous 30 days
  // Use createdAt as proxy (ideally track sync timestamps separately)
  const recent30 = projects.filter(p => p.createdAt && new Date(p.createdAt) >= thirtyDaysAgo).length;
  const previous30 = projects.filter(
    p => p.createdAt && new Date(p.createdAt) >= sixtyDaysAgo && new Date(p.createdAt) < thirtyDaysAgo
  ).length;
  const syncTrendPercentage = previous30 > 0 ? Math.round(((recent30 - previous30) / previous30) * 100) : 0;

  return {
    totalProjects,
    totalLines,
    syncedLines,
    completionPercentage,
    averageProjectCompletion,
    averageLinesPerProject,
    fullySyncedProjects,
    musicSyncedMinutes: user.stats?.minutesSynced ?? 0,
    wordsTimestamped: user.stats?.wordsSynced ?? 0,
    karaokeLines: user.stats?.karaokeLines ?? 0,
    publicProjects,
    starsReceived: user.social?.totalStarsReceived ?? 0,
    forksReceived: user.social?.totalForksReceived ?? 0,
    mostSyncedProject: mostSyncedProject
      ? {
          title: mostSyncedProject.title,
          syncedLines: mostSyncedProject.syncedLines,
        }
      : null,
    largestProject: largestProject
      ? {
          title: largestProject.title,
          totalLines: largestProject.totalLines,
        }
      : null,
    syncTrendPercentage,
  };
}

function countTotalLines(lyric: any): number {
  let count = 0;
  for (const section of lyric.sections ?? []) {
    count += (section.lines ?? []).length;
  }
  return count;
}

function countSyncedLines(lyric: any): number {
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
