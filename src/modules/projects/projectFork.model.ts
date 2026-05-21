import mongoose from 'mongoose';

const projectForkSchema = new mongoose.Schema(
  {
    sourceProjectId: { type: String, required: true },
    forkedProjectId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'project_forks' }
);

projectForkSchema.index({ sourceProjectId: 1 });
projectForkSchema.index({ userId: 1 });

export default mongoose.model('ProjectFork', projectForkSchema);
