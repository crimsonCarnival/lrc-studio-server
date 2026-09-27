import { MercuriusContext } from 'mercurius';

export interface Context extends MercuriusContext {
  userId?: string | null;
  bannedUserId?: string;
  ip?: string;
  tokenExpired?: boolean;
  socketId?: string;
  /** The client's `X-Device-Id` header, used to key anonymous view dedup. */
  deviceId?: string;
  /** True when the caller holds a valid admin sudo grant bound to userId. */
  hasSudo?: boolean;
}
