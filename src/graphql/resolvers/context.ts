import { MercuriusContext } from 'mercurius';

export interface Context extends MercuriusContext {
  userId?: string | null;
  ip?: string;
  tokenExpired?: boolean;
}
