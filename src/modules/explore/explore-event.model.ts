import mongoose from 'mongoose';

// Anonymous, aggregated Explore feed telemetry: how often a project was shown and
// opened, per UTC day. Deliberately holds no user, device or IP, so it cannot be
// turned into a browsing history. It exists to tune the trending weights
// (jobs/trending.score.ts) against real click-through.
export type IExploreEvent = {
  publicId: string;
  day: Date;
  impressions: number;
  clicks: number;
  /** Sum of the feed positions (0-based) at which impressions happened; avg position = positionSum / impressions. */
  positionSum: number;
};

const exploreEventSchema = new mongoose.Schema<IExploreEvent>(
  {
    publicId: { type: String, required: true },
    day: { type: Date, required: true },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    positionSum: { type: Number, default: 0 },
  },
  { collection: 'explore_events', timestamps: false },
);

exploreEventSchema.index({ publicId: 1, day: 1 }, { unique: true });
// Tuning only needs recent data; the TTL also bounds the collection.
exploreEventSchema.index({ day: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model<IExploreEvent>('ExploreEvent', exploreEventSchema);
