import mongoose from 'mongoose';
import User from '../db/user.model.js';

// UserArchive uses an empty schema with strict: false so it can store any shape
// of user document without requiring a mirrored schema definition. This is
// intentional — archived records must preserve the exact structure they had at
// deletion time, including any fields added in future migrations.
const UserArchive = mongoose.model(
  'UserArchive',
  new mongoose.Schema({}, { strict: false, collection: 'users_archive' })
);

export async function archiveDeletedUsers() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const toArchive = await User.find({
    isDeleted: true,
    deletedAt: { $lt: cutoff },
  }).lean();

  if (toArchive.length === 0) return;

  const ids = toArchive.map((u) => u._id);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await UserArchive.insertMany(toArchive, { ordered: false, session });
      await User.deleteMany({ _id: { $in: ids } }, { session });
    });
  } finally {
    await session.endSession();
  }

  console.log(`[archiveDeletedUsers] Archived ${toArchive.length} users deleted before ${cutoff.toISOString()}`);
}
