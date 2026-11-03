import mongoose from 'mongoose'

const collabDocSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    state: { type: Buffer, required: true },
    // Lyrics.version this state was seeded from or last projected into. A load that
    // finds Lyrics at another version (edited outside collab since) re-seeds instead
    // of resurrecting the stale state over those edits.
    lyricsVersion: { type: Number, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
)

export default mongoose.model('CollabDoc', collabDocSchema)
