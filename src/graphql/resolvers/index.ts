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
import { shelfResolvers }    from './shelf.resolvers.js';
import { badgeResolvers }    from './badge.resolvers.js';
import { wallResolvers }     from './wall.resolvers.js';
import { reportResolvers }   from './report.resolvers.js';
import { collabResolvers }   from './collab.resolvers.js';
import { catalogResolvers }  from './catalog.resolvers.js';

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
    ...shelfResolvers.Query,
    ...badgeResolvers.Query,
    ...wallResolvers.Query,
    ...reportResolvers.Query,
    ...collabResolvers.Query,
    ...catalogResolvers.Query,
  },
  Mutation: {
    ...userResolvers.Mutation,
    ...projectResolvers.Mutation,
    ...lyricsResolvers.Mutation,
    ...uploadResolvers.Mutation,
    ...settingsResolvers.Mutation,
    ...playlistResolvers.Mutation,
    ...exploreResolvers.Mutation,
    ...reactionResolvers.Mutation,
    ...statsResolvers.Mutation,
    ...requestResolvers.Mutation,
    ...shelfResolvers.Mutation,
    ...badgeResolvers.Mutation,
    ...wallResolvers.Mutation,
    ...reportResolvers.Mutation,
    ...collabResolvers.Mutation,
    ...catalogResolvers.Mutation,
  },
  User:     userResolvers.User,
  UserBan: userResolvers.UserBan,
  UserAppeal: userResolvers.UserAppeal,
  PublicUser: publicUserResolvers,
  FollowUser: followUserResolvers,
  Project:  projectResolvers.Project,
  ExportSettings: settingsResolvers.ExportSettings,
  ProjectMetadata: projectResolvers.ProjectMetadata,
  Lyrics:   lyricsResolvers.Lyrics,
  Upload:   uploadResolvers.Upload,
  Activity: activityResolvers.Activity,
  CatalogArtist: catalogResolvers.CatalogArtist,
  CatalogAlbum:  catalogResolvers.CatalogAlbum,
  CatalogArtistPage: catalogResolvers.CatalogArtistPage,
};
