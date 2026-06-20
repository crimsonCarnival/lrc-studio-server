import mongoose, { type Document, type Model } from 'mongoose';

export interface IPasskey extends Document {
  credentialID: string;
  credentialPublicKey: Buffer;
  counter: number;
  transports?: string[];
  userId: mongoose.Types.ObjectId;
  deviceName?: string;
  browser?: string;
  os?: string;
  deviceType?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const passkeySchema = new mongoose.Schema<IPasskey>(
  {
    credentialID: {
      type: String,
      required: true,
      unique: true,
    },
    credentialPublicKey: {
      type: Buffer,
      required: true,
    },
    counter: {
      type: Number,
      required: true,
      default: 0,
    },
    transports: {
      type: [String],
      default: [],
    },
    deviceName: { type: String },
    browser: { type: String },
    os: { type: String },
    deviceType: { type: String },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true, collection: 'passkeys' }
);

export default mongoose.model<IPasskey, Model<IPasskey>>('Passkey', passkeySchema);
