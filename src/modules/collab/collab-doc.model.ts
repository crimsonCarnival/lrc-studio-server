import mongoose from 'mongoose'

const collabDocSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    state: { type: Buffer, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
)

export default mongoose.model('CollabDoc', collabDocSchema)
