import mongoose from 'mongoose';
import { WallCommentReport, type IWallCommentReport } from '../wall/wall.models.js';
import { Report } from './report.model.js';

type LeanWallReport = IWallCommentReport & { _id: mongoose.Types.ObjectId };

export interface CopyResult {
  scanned: number;
  inserted: number;
  /** Already in `reports` (an earlier run, or filed again since the deploy): left untouched. */
  skipped: number;
}

/**
 * Copies every wall_comment_reports row into the generic `reports` collection. Idempotent:
 * rows are matched on (wall_comment, commentId, reporterId) and only ever inserted, never
 * overwritten, so re-running is safe and a report filed through the new path wins over its
 * older copy. The original _id is kept, so report ids an old client already holds still
 * resolve. The old collection is left as it is.
 */
export async function copyWallReports({ dryRun = false, batchSize = 500 }: { dryRun?: boolean; batchSize?: number } = {}): Promise<CopyResult> {
  const result: CopyResult = { scanned: 0, inserted: 0, skipped: 0 };
  const cursor = WallCommentReport.find({}).sort({ _id: 1 }).lean<LeanWallReport[]>().cursor({ batchSize });
  for await (const old of cursor as AsyncIterable<LeanWallReport>) {
    result.scanned++;
    const key = { targetType: 'wall_comment' as const, targetId: old.commentId, reporterId: old.reporterId };
    if (dryRun) {
      if (await Report.exists(key)) result.skipped++;
      else result.inserted++;
      continue;
    }
    const res = await Report.updateOne(
      key,
      {
        $setOnInsert: {
          _id: old._id,
          ...key,
          subjectUserId: old.authorId ?? null,
          contextUserId: old.wallUserId ?? null,
          reason: old.reason,
          note: old.note ?? '',
          status: old.status ?? 'open',
          resolvedBy: old.resolvedBy ?? null,
          resolvedAt: old.resolvedAt ?? null,
          createdAt: old.createdAt,
        },
      },
      { upsert: true, timestamps: false },
    );
    if (res.upsertedCount > 0) result.inserted++;
    else result.skipped++;
  }
  return result;
}
