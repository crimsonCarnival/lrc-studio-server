import mongoose from 'mongoose';

const projectStarSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'project_stars' }
);

projectStarSchema.index({ projectId: 1, userId: 1 }, { unique: true });
projectStarSchema.index({ userId: 1 });

export default mongoose.model('ProjectStar', projectStarSchema);
