export type CatalogStatus = 'pending' | 'approved' | 'rejected';
export type CatalogSource = 'community' | 'admin';

export const CATALOG_STATUSES: readonly CatalogStatus[] = ['pending', 'approved', 'rejected'];
export const CATALOG_SOURCES: readonly CatalogSource[] = ['community', 'admin'];
