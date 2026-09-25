import { MercuriusContext } from 'mercurius';

export interface Context extends MercuriusContext {
  userId?: string | null;
  bannedUserId?: string;
  ip?: string;
  tokenExpired?: boolean;
  socketId?: string;
  /** True when the caller holds a valid admin sudo grant bound to userId. */
  hasSudo?: boolean;
}
