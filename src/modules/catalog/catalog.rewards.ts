// TODO(Task 7): implement. award increments the submitter's catalogArtistsApproved /
// catalogAlbumsApproved counter and recomputes XP; revoke is the inverse for abuse deletions.
export async function awardCatalogCredit(_userId: string, _kind: 'artist' | 'album'): Promise<void> {}

export async function revokeCatalogCredit(_userId: string, _kind: 'artist' | 'album'): Promise<void> {}
