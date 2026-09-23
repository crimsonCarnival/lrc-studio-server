import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/lrc-studio';

async function runMigration() {
  console.log(`Connecting to MongoDB at ${MONGODB_URI}`);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established.');
  }

  // 1. Settings Collection
  console.log('--- Migrating Settings ---');
  const settingsUnset = {
    theme: '',
    timestampPrecision: '',
    timezone: '',
  };
  const settingsResult = await db.collection('settings').updateMany(
    { $or: Object.keys(settingsUnset).map((key) => ({ [key]: { $exists: true } })) },
    { $unset: settingsUnset }
  );
  console.log(`Updated ${settingsResult.modifiedCount} settings documents.`);

  // 2. Projects Collection
  console.log('--- Migrating Projects ---');
  const projectsUnset = {
    projectId: '',
    timezone: '',
    utcOffset: '',
    expiresAt: '',
    username: '',
  };
  const projectsResult = await db.collection('projects').updateMany(
    { $or: Object.keys(projectsUnset).map((key) => ({ [key]: { $exists: true } })) },
    { $unset: projectsUnset }
  );
  console.log(`Updated ${projectsResult.modifiedCount} project documents.`);

  // 3. Uploads Collection
  console.log('--- Migrating Uploads ---');
  const uploadsUnset = {
    spotifyTrackId: '',
    youtubeUrl: '',
    artist: '',
    cloudinaryUrl: '',
  };
  const uploadsResult = await db.collection('uploads').updateMany(
    { $or: Object.keys(uploadsUnset).map((key) => ({ [key]: { $exists: true } })) },
    { $unset: uploadsUnset }
  );
  console.log(`Updated ${uploadsResult.modifiedCount} upload documents.`);

  // 4. Lyrics Collection
  console.log('--- Migrating Lyrics ---');
  const lyricsUnset = {
    singer: '',
    singer2: '',
    depth: '',
  };
  const lyricsResult = await db.collection('lyrics').updateMany(
    { $or: Object.keys(lyricsUnset).map((key) => ({ [key]: { $exists: true } })) },
    { $unset: lyricsUnset }
  );
  console.log(`Updated ${lyricsResult.modifiedCount} lyrics documents.`);

  // 5. Notifications Collection
  console.log('--- Migrating Notifications ---');
  const notificationsUnset = {
    projectId: '',
  };
  const notificationsResult = await db.collection('notifications').updateMany(
    { projectId: { $exists: true } },
    { $unset: notificationsUnset }
  );
  console.log(`Updated ${notificationsResult.modifiedCount} notification documents.`);

  // 6. Project Forks Collection
  console.log('--- Migrating Project Forks ---');
  const projectForksUnset = {
    sourceProjectId: '',
    forkedProjectId: '',
  };
  const projectForksResult = await db.collection('project_forks').updateMany(
    { $or: Object.keys(projectForksUnset).map((key) => ({ [key]: { $exists: true } })) },
    { $unset: projectForksUnset }
  );
  console.log(`Updated ${projectForksResult.modifiedCount} project_fork documents.`);

  // 7. Project Stars Collection
  console.log('--- Migrating Project Stars ---');
  const projectStarsUnset = {
    projectId: '',
  };
  const projectStarsResult = await db.collection('project_stars').updateMany(
    { projectId: { $exists: true } },
    { $unset: projectStarsUnset }
  );
  console.log(`Updated ${projectStarsResult.modifiedCount} project_star documents.`);

  console.log('Migration complete.');
  await mongoose.disconnect();
  console.log('Disconnected.');
}

runMigration().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
