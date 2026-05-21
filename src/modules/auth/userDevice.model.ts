import mongoose from 'mongoose';

const userDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, unique: true },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'user_devices' }
);

userDeviceSchema.index({ userId: 1 });
// TTL: expire devices not seen in 1 year
userDeviceSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export default mongoose.model('UserDevice', userDeviceSchema);
