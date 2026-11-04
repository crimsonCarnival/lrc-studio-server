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
    avatarUrl: { type: String, default: null },
    // Guests only: the invite they joined with, so a kick can revoke it (a kicked
    // guest could otherwise mint a fresh guest id from the same link).
    inviteId: { type: String, default: undefined, maxlength: 24 },
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
    // Last edit, connect or disconnect; written at most once a minute. A session idle for a day ends.
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
)

// One live session per project; ended sessions keep their publicId for history.
collabSessionSchema.index({ publicId: 1 }, { unique: true, partialFilterExpression: { endedAt: null } })
// POST /collab/join looks a session up by the sha256 of its invite token.
collabSessionSchema.index({ 'invites.tokenHash': 1 })
// The idle sweep.
collabSessionSchema.index({ lastActivityAt: 1 }, { partialFilterExpression: { endedAt: null } })

export default mongoose.model('CollabSession', collabSessionSchema)
