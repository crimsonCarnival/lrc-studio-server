// TODO(Task 7): implement. award increments the submitter's catalogArtistsApproved /
// catalogAlbumsApproved counter and recomputes XP; revoke is the inverse for abuse deletions.
export async function awardCatalogCredit(_userId: string, _kind: 'artist' | 'album'): Promise<void> {}

// Contract (Task 7): applies ONE atomic guarded $inc on the submitter's counter first, then
// recomputes XP/badges from stats. Idempotent and safe to re-run: callers log a throw for
// manual repair and never abort a delete or restore creditAwarded because of it.
export async function revokeCatalogCredit(_userId: string, _kind: 'artist' | 'album'): Promise<void> {}
