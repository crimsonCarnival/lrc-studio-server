import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import { notifyProjectsPrivatized } from '../notifications/notifications.service.js';

export type PrivatizeMatch = { publicId: string; title: string; timed: number; total: number };
export type PrivatizeFailure = { publicId: string; error: string };
export type PrivatizeResult = { matched: PrivatizeMatch[]; changed: number; skippedChanged: number; failed: PrivatizeFailure[] };

export type PrivatizeOptions = {
  dryRun: boolean;
  /**
   * Removes non-owners from the project's Socket.IO room. Optional because a
   * standalone script has no running Socket.IO server; without it, viewers
   * already in a room keep receiving pushes until they disconnect (restart the
   * server after --apply), but every read is denied once `public` is false.
   */
  evictNonOwners?: (publicId: string, ownerId: string | null) => Promise<void>;
  log?: (message: string) => void;
  /** Test seam: runs between the scan and the write of each project. */
  beforeWrite?: (publicId: string) => Promise<void>;
};

export type ParsedArgs = { ok: true; apply: boolean } | { ok: false; error: string };

export const PRIVATIZE_USAGE = 'Usage: pnpm tsx scripts/privatize-incomplete-projects.ts [--apply]   (no flag = dry run; a literal `--` separator is rejected)';

/** Dry run is the default; `--dry-run` is accepted but may not be combined with `--apply`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const unknown = argv.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length) return { ok: false, error: `Unknown argument(s): ${unknown.join(' ')}` };
  if (argv.includes('--apply') && argv.includes('--dry-run')) return { ok: false, error: '--apply and --dry-run cannot be combined' };
  return { ok: true, apply: argv.includes('--apply') };
}

const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(:\d{1,5})?$/;
const DB_RE = /^[A-Za-z0-9._-]*$/;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/is;

/**
 * `host[:port][,host...]/database` of a Mongo URI. Allowlist: only validated host
 * and database tokens are ever returned, never credentials or options. The query
 * string is cut first, and everything up to the LAST `@` is treated as userinfo
 * (a raw `/`, `@` or `?` in a password cannot leak that way). Anything that does
 * not validate yields `<unparseable target>`.
 */
export function describeMongoTarget(uri: string): string {
  const bad = '<unparseable target>';
  const m = URI_RE.exec(uri.split('?')[0]);
  if (!m) return bad;
  const afterUser = m[1].slice(m[1].lastIndexOf('@') + 1);
  const slash = afterUser.indexOf('/');
  const hosts = slash === -1 ? afterUser : afterUser.slice(0, slash);
  const db = slash === -1 ? '' : afterUser.slice(slash + 1).split('/')[0];
  if (!hosts || !hosts.split(',').every((h) => HOST_RE.test(h)) || !DB_RE.test(db)) return bad;
  return `${hosts}/${db || '(default db)'}`;
}

/** Removes the URI, its userinfo (raw and decoded) and any other mongodb URI from `text`. */
export function redactSecrets(text: string, uri = ''): string {
  let out = text;
  const secrets: string[] = [];
  if (uri) {
    secrets.push(uri);
    const m = URI_RE.exec(uri.split('?')[0]);
    const at = m ? m[1].lastIndexOf('@') : -1;
    if (m && at > 0) {
      const userinfo = m[1].slice(0, at);
      secrets.push(userinfo);
      const colon = userinfo.indexOf(':');
      const parts = colon === -1 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
      for (const part of parts) {
        secrets.push(part);
        try { secrets.push(decodeURIComponent(part)); } catch { /* not decodable */ }
      }
    }
  }
  for (const secret of secrets.sort((x, y) => y.length - x.length)) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out.replace(/mongodb(\+srv)?:\/\/\S+/gi, '<redacted-uri>');
}

type LyricsLines = { sections?: { lines?: { type?: string; timestamp?: number | null; words?: { time?: number | null }[] | null }[] }[] } | null;

/** Section markers are not lyric lines; a timestamp of 0 is timed; a word time also counts. */
function countLines(lyrics: LyricsLines): { timed: number; total: number } {
  let timed = 0;
  let total = 0;
  for (const section of lyrics?.sections ?? []) {
    for (const line of section.lines ?? []) {
      if (line.type === 'section') continue;
      total++;
      if (line.timestamp != null || (line.words ?? []).some((w) => w?.time != null)) timed++;
    }
  }
  return { timed, total };
}

/**
 * Makes public projects with any untimed lyric line (or no lyric lines at all)
 * private. Fully timed projects are left alone. Idempotent: matching requires
 * `public: true`, so a second run finds nothing.
 *
 * A line is timed if it has a timestamp or any timed word (as in sync-stats);
 * an endTime alone does not count. Section markers never count.
 *
 * Race safety (narrowed, not closed): the scan records each project's
 * `contentUpdatedAt` and the lyrics `version`/`updatedAt`. Every real lyric
 * write bumps at least `updatedAt` (most also `version` and `contentUpdatedAt`).
 * Just before writing, the lyrics stamp is re-read and the project update is
 * conditional on `contentUpdatedAt`; changed projects are skipped and counted in
 * `skippedChanged`. A lyric write landing between the lyrics re-read and the
 * project update, without touching `contentUpdatedAt`, could still be
 * privatized.
 *
 * `updatedAt`, `contentUpdatedAt` and `firstPublishedAt` are not touched
 * (visibility is not an edit). Each project is logged right after its write.
 * A failure on one project is recorded in `failed` and the run continues. One
 * `system` notification per owner goes out right after that owner's projects,
 * counting only those actually written; owner-less (guest) projects are
 * privatized but notify nobody. A notification failure is logged, not fatal.
 */
export async function privatizeIncomplete(options: PrivatizeOptions): Promise<PrivatizeResult> {
  const { dryRun, evictNonOwners, log, beforeWrite } = options;
  const matched: PrivatizeMatch[] = [];
  const failed: PrivatizeFailure[] = [];
  let changed = 0;
  let skippedChanged = 0;
  const fail = (publicId: string, err: unknown): void => {
    failed.push({ publicId, error: redactSecrets(err instanceof Error ? err.message : String(err)) });
  };

  type Candidate = { publicId: string; ownerId: string | null; contentUpdatedAt: Date | null; lyricsStamp: string };
  const candidates: Candidate[] = [];
  const stampOf = (l: { version?: number; updatedAt?: Date } | null): string => l ? `${l.version ?? ''}|${l.updatedAt?.getTime() ?? ''}` : 'none';

  const cursor = Project.find({ public: true }).select('publicId title userId contentUpdatedAt').lean().cursor();
  for await (const project of cursor) {
    try {
      const lyrics = await Lyrics.findOne({ publicId: project.publicId }).select('sections version updatedAt').lean<LyricsLines & { version?: number; updatedAt?: Date }>();
      const { timed, total } = countLines(lyrics);
      if (total > 0 && timed === total) continue;
      matched.push({ publicId: project.publicId, title: project.title ?? '', timed, total });
      candidates.push({
        publicId: project.publicId,
        ownerId: project.userId ? project.userId.toString() : null,
        contentUpdatedAt: project.contentUpdatedAt ?? null,
        lyricsStamp: stampOf(lyrics),
      });
    } catch (err) {
      fail(project.publicId, err);
    }
  }
  if (dryRun) return { matched, changed: 0, skippedChanged: 0, failed };

  // Group by owner so each owner is notified as soon as their projects are written.
  const byOwner = new Map<string | null, Candidate[]>();
  for (const c of candidates) byOwner.set(c.ownerId, [...(byOwner.get(c.ownerId) ?? []), c]);

  const counts: Record<string, number> = {};
  try {
    for (const [ownerId, list] of byOwner) {
      let ownerChanged = 0;
      for (const c of list) {
        try {
          if (beforeWrite) await beforeWrite(c.publicId);
          const now = await Lyrics.findOne({ publicId: c.publicId }).select('version updatedAt').lean<{ version?: number; updatedAt?: Date } | null>();
          if (stampOf(now) !== c.lyricsStamp) { skippedChanged++; continue; }

          const res = await Project.updateOne(
            { publicId: c.publicId, public: true, contentUpdatedAt: c.contentUpdatedAt ?? { $in: [null] } },
            { $set: { public: false } },
            { timestamps: false },
          );
          if (res.modifiedCount === 0) {
            if (await Project.exists({ publicId: c.publicId, public: true })) skippedChanged++;
            continue;
          }
          ownerChanged++;
          log?.(`privatized ${c.publicId} (owner ${ownerId ?? 'none'})`);
          if (evictNonOwners) {
            try { await evictNonOwners(c.publicId, ownerId); } catch { /* best effort */ }
          }
        } catch (err) {
          fail(c.publicId, err);
        }
      }
      changed += ownerChanged;
      if (!ownerId || ownerChanged === 0) continue;
      counts[ownerId] = ownerChanged;
      try {
        await notifyProjectsPrivatized(ownerId, ownerChanged);
      } catch (err) {
        log?.(`notification failed for ${ownerId}: ${redactSecrets((err as Error).message)}`);
      }
    }
  } finally {
    log?.(`owner -> privatized count (for recovery): ${JSON.stringify(counts)}`);
    if (failed.length) log?.(`failed (${failed.length}): ${JSON.stringify(failed)}`);
  }
  return { matched, changed, skippedChanged, failed };
}
