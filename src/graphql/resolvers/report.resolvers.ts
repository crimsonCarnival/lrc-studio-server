import mercurius from 'mercurius';
import { Context } from './context.js';
import {
  ReportError, fileReport, listReportGroups, listMyReports, openReportCount, requireModerator, resolveReportGroup,
} from '../../modules/reports/reports.service.js';

// The client switches on `extensions.code`, so a ReportError keeps its code.
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ReportError) throw new mercurius.ErrorWithProps(err.code, { code: err.code.toUpperCase() });
    throw err;
  }
}

function requireUser(ctx: Context): string {
  if (!ctx.userId) throw new mercurius.ErrorWithProps('UNAUTHORIZED', { code: 'UNAUTHORIZED' });
  return ctx.userId;
}

export const reportResolvers = {
  Query: {
    reportGroups: (_: unknown, args: { status?: string | null; targetType?: string | null; limit?: number | null }, ctx: Context) =>
      guarded(() => listReportGroups(requireUser(ctx), args)),
    openReportCount: (_: unknown, __: unknown, ctx: Context) =>
      guarded(async () => { await requireModerator(requireUser(ctx)); return openReportCount(); }),
    myReports: (_: unknown, args: { limit?: number | null; offset?: number | null }, ctx: Context) =>
      guarded(() => listMyReports(requireUser(ctx), args.limit ?? 50, args.offset ?? 0)),
  },
  Mutation: {
    fileReport: (
      _: unknown,
      args: { targetType: string; targetId: string; reason: string; note?: string | null; alsoBlock?: boolean | null },
      ctx: Context,
    ) => guarded(() => fileReport(requireUser(ctx), args)),
    resolveReportGroup: (_: unknown, args: { targetType: string; targetId: string; action: string }, ctx: Context) =>
      guarded(() => resolveReportGroup(requireUser(ctx), args, { hasSudo: ctx.hasSudo === true, ip: ctx.ip ?? null })),
  },
};
