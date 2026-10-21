import mongoose, { type Model } from 'mongoose';

/**
 * MongoDB-backed store for the Google OAuth one-time token (see ott.service.ts
 * for why the OTT hop exists at all). Was a process-local `Map` — correct for
 * a single instance, but the mint (callback, instance A) and the consume
 * (POST /auth/exchange-ott, instance B) can land on different instances
 * behind a load balancer, which made Google sign-in fail non-deterministically
 * with a misleading "expired token" error roughly (N-1)/N of the time.
 *
 * Holds the literal access/refresh token pair, not a hash — unlike
 * email-verification's tokenHash, this has to be *returned* to the client on
 * consume, not just compared against. That is the same exposure window the
 * in-memory Map already had (60s, single-use, deleted immediately); storing
 * it in Mongo doesn't widen it — the tokens are themselves bearer credentials,
 * so whoever holds the opaque `id` could already redeem them regardless of
 * where the pair sits meanwhile.
 */
// Not `extends Document`: Mongoose's Document type pins `_id` to ObjectId,
// which conflicts with the string id this collection actually uses (the
// opaque id itself — crypto.randomBytes(16).toString('hex')). Every caller
// reads this through .lean() anyway, so a plain shape is all that's needed.
export interface IOneTimeToken {
  _id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

const oneTimeTokenSchema = new mongoose.Schema<IOneTimeToken>(
  {
    _id: { type: String, required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'one_time_tokens', versionKey: false }
);

oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const OneTimeToken: Model<IOneTimeToken> = mongoose.model('OneTimeToken', oneTimeTokenSchema);
export default OneTimeToken;
