import { healthResolvers }   from './health.resolvers.js';
import { userResolvers }     from './user.resolvers.js';
import { projectResolvers }  from './project.resolvers.js';
import { lyricsResolvers }   from './lyrics.resolvers.js';
import { uploadResolvers }   from './upload.resolvers.js';
import { settingsResolvers } from './settings.resolvers.js';
import { playlistResolvers } from './playlist.resolvers.js';
import { activityResolvers } from './activity.resolvers.js';
import { exploreResolvers }  from './explore.resolvers.js';
import { commentResolvers }  from './comment.resolvers.js';

export const resolvers = {
  Query: {
    ...healthResolvers.Query,
    ...userResolvers.Query,
    ...projectResolvers.Query,
    ...uploadResolvers.Query,
    ...settingsResolvers.Query,
    ...playlistResolvers.Query,
    ...activityResolvers.Query,
    ...exploreResolvers.Query,
    ...commentResolvers.Query,
  },
  Mutation: {
    ...userResolvers.Mutation,
    ...projectResolvers.Mutation,
    ...lyricsResolvers.Mutation,
    ...uploadResolvers.Mutation,
    ...settingsResolvers.Mutation,
    ...playlistResolvers.Mutation,
    ...commentResolvers.Mutation,
  },
  User:     userResolvers.User,
  Project:  projectResolvers.Project,
  Lyrics:   lyricsResolvers.Lyrics,
  Upload:   uploadResolvers.Upload,
  Activity: activityResolvers.Activity,
};
