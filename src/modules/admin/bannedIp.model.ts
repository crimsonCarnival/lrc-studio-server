import mongoose from 'mongoose';

const bannedIpSchema = new mongoose.Schema(
  {
    ip: {
      type: String,
      required: true,
      unique: true,
    },
    reason: {
      type: String,
      default: null,
    },
    bannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, collection: 'banned_ips' }
);

// Auto-expire after 2 years — dynamic IPs rotate; manual re-ban if still needed
bannedIpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 60 * 60 });

export default mongoose.model('BannedIp', bannedIpSchema);