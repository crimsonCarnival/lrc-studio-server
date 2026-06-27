import { MercuriusContext } from 'mercurius';

export interface Context extends MercuriusContext {
  userId?: string | null;
  bannedUserId?: string;
  ip?: string;
  tokenExpired?: boolean;
  socketId?: string;
}
