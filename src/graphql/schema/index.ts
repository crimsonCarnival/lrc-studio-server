import { userSchema } from './user.schema.js';
import { projectSchema } from './project.schema.js';
import { lyricsSchema } from './lyrics.schema.js';
import { uploadSchema } from './upload.schema.js';
import { settingsSchema } from './settings.schema.js';
import { rootSchema } from './root.schema.js';

export const schemaString = [userSchema, projectSchema, lyricsSchema, uploadSchema, settingsSchema, rootSchema].join('\n');
