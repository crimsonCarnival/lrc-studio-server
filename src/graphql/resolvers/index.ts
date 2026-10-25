import { healthResolvers }   from './health.resolvers.js';
import { userResolvers, publicUserResolvers, followUserResolvers } from './user.resolvers.js';
import { projectResolvers }  from './project.resolvers.js';
import { lyricsResolvers }   from './lyrics.resolvers.js';
import { uploadResolvers }   from './upload.resolvers.js';
import { settingsResolvers } from './settings.resolvers.js';
import { playlistResolvers } from './playlist.resolvers.js';
import { activityResolvers } from './activity.resolvers.js';
import { exploreResolvers }  from './explore.resolvers.js';
import { reactionResolvers } from './reaction.resolvers.js';
import { statsResolvers }    from './stats.resolvers.js';
import { requestResolvers }  from './request.resolvers.js';
import { artistResolvers }   from './artist.resolvers.js';
import { badgeResolvers }    from './badge.resolvers.js';
import { wallResolvers }     from './wall.resolvers.js';

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
    ...reactionResolvers.Query,
    ...statsResolvers.Query,
    ...requestResolvers.Query,
    ...artistResolvers.Query,
    ...badgeResolvers.Query,
    ...wallResolvers.Query,
  },
  Mutation: {
    ...userResolvers.Mutation,
    ...projectResolvers.Mutation,
    ...lyricsResolvers.Mutation,
    ...uploadResolvers.Mutation,
    ...settingsResolvers.Mutation,
    ...playlistResolvers.Mutation,
    ...reactionResolvers.Mutation,
    ...statsResolvers.Mutation,
    ...requestResolvers.Mutation,
    ...badgeResolvers.Mutation,
    ...wallResolvers.Mutation,
  },
  User:     userResolvers.User,
  PublicUser: publicUserResolvers,
  FollowUser: followUserResolvers,
  Project:  projectResolvers.Project,
  ExportSettings: settingsResolvers.ExportSettings,
  ProjectMetadata: projectResolvers.ProjectMetadata,
  Lyrics:   lyricsResolvers.Lyrics,
  Upload:   uploadResolvers.Upload,
  Activity: activityResolvers.Activity,
};
