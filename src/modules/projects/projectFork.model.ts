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

export default mongoose.model('ProjectFork', projectForkSchema);
