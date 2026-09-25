import mongoose from 'mongoose';

/**
 * Records that a code-defined default (e.g. an addiction level) has been
 * seeded at least once. Lets the seeder insert defaults added to code later
 * without resurrecting defaults an admin deliberately deleted.
 * `_id` is `<kind>:<key>`, e.g. `addiction_level:beat_deaf`.
 */
export interface ISeedMarker {
  _id: string;
  createdAt?: Date;
}

const seedMarkerSchema = new mongoose.Schema<ISeedMarker>(
  { _id: { type: String, required: true } },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'seed_markers', versionKey: false }
);

export default mongoose.model<ISeedMarker>('SeedMarker', seedMarkerSchema);
