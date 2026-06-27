import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/db/user.model.js';
import { recomputeSyncStats } from '../src/modules/badges/badge.service.js';

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error('Error: MONGODB_URI is not defined in .env');
  process.exit(1);
}

async function backfillStats() {
  try {
    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(uri);
    console.log('Connected.');

    const users = await User.find({ isDeleted: { $ne: true } }).select('_id accountName');
    console.log(`Found ${users.length} active users. Starting backfill...`);

    let processed = 0;
    for (const user of users) {
      try {
        await recomputeSyncStats(user._id.toString());
        processed++;
        if (processed % 10 === 0) {
          console.log(`Processed ${processed}/${users.length} users...`);
        }
      } catch (err) {
        console.error(`Failed to process user ${user.accountName} (${user._id}):`, err);
      }
    }

    console.log(`\nBackfill complete! Processed ${processed} users.`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

backfillStats();
