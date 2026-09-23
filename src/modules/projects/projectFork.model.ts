import mongoose from 'mongoose';

const projectForkSchema = new mongoose.Schema(
  {
    sourcepublicId: { type: String, required: true },
    forkedpublicId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'project_forks' }
);

projectForkSchema.index({ sourcepublicId: 1 });
projectForkSchema.index({ userId: 1 });

// Compound unique index to prevent duplicate fork entries per source + user
// DEPLOY NOTE: if this collection has duplicate (sourcepublicId, userId) rows from before this fix,
// the index build will fail. Run a one-time dedupe pass first (keep earliest createdAt per pair).
projectForkSchema.index({ sourcepublicId: 1, userId: 1 }, { unique: true, sparse: true });

export default mongoose.model('ProjectFork', projectForkSchema);
