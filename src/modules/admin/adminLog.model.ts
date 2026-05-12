import mongoose from 'mongoose';

const adminLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    adminName: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    targetName: {
      type: String,
      default: null,
    },
    details: {
      type: String,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
  },
  { timestamps: true, collection: 'admin_logs' }
);

export default mongoose.model('AdminLog', adminLogSchema);