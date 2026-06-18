import { userSchema } from './user.schema.js';
import { projectSchema } from './project.schema.js';
import { lyricsSchema } from './lyrics.schema.js';
import { uploadSchema } from './upload.schema.js';
import { settingsSchema } from './settings.schema.js';
import { rootSchema } from './root.schema.js';
import { playlistSchema } from './playlist.schema.js';
import { activitySchema } from './activity.schema.js';
import { exploreSchema } from './explore.schema.js';
import { reactionSchema } from './reaction.schema.js';

export const schemaString = [
  userSchema, projectSchema, lyricsSchema, uploadSchema,
  settingsSchema, playlistSchema, activitySchema, exploreSchema, reactionSchema, rootSchema,
].join('\n');
