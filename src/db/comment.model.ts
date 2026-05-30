import mongoose from 'mongoose';

export interface IComment {
  projectId: string;
  userId: mongoose.Types.ObjectId;
  text: string;
  parentId: mongoose.Types.ObjectId | null;
  replyCount: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new mongoose.Schema<IComment>(
  {
    projectId: { type: String, required: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text:      { type: String, required: true, maxlength: 1000 },
    parentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    replyCount: { type: Number, default: 0 },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'comments' }
);

commentSchema.index({ projectId: 1, parentId: 1, createdAt: -1 });
commentSchema.index({ parentId: 1, createdAt: 1 });

export default mongoose.model<IComment>('Comment', commentSchema);
