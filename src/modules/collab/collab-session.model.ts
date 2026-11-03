import mongoose from 'mongoose'

// subject: `user:<userId>` or `guest:<nanoid>`
const inviteSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    role: { type: String, enum: ['editor', 'viewer'], required: true },
    revokedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
)

const memberSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true },
    role: { type: String, enum: ['owner', 'editor', 'viewer'], required: true },
    colorIndex: { type: Number, required: true, min: 1, max: 8 },
    name: { type: String, required: true, maxlength: 40 },
  },
  { _id: false },
)

const collabSessionSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    allowGuests: { type: Boolean, default: true },
    invites: { type: [inviteSchema], default: [] },
    members: { type: [memberSchema], default: [] },
    kicked: { type: [String], default: [] },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

// One live session per project; ended sessions keep their publicId for history.
collabSessionSchema.index({ publicId: 1 }, { unique: true, partialFilterExpression: { endedAt: null } })

export default mongoose.model('CollabSession', collabSessionSchema)
