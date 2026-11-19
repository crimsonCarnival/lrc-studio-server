import type { FastifyReply, FastifyRequest } from 'fastify';
import { copyGeniusAlbumCover, copyGeniusArtistPhoto, searchGeniusAlbums, searchGeniusArtists } from './catalog.genius.service.js';
import { copyProjectCover, listProjectCoverProposals } from './catalog.album-cover.service.js';
import { isError, type CatalogError } from './catalog.service.js';

const send = (reply: FastifyReply, e: CatalogError) =>
  reply.code(e.status).send({ error: e.error, code: e.code.toLowerCase() });

// Upstream text is never echoed: a thrown Genius failure becomes a fixed opaque body.
const upstream = (reply: FastifyReply) =>
  reply.code(502).send({ error: 'Genius is unavailable right now', code: 'catalog_genius_upstream' });

export async function geniusArtists(request: FastifyRequest, reply: FastifyReply) {
  try {
    const artists = await searchGeniusArtists(request.userId as string, (request.query as { q: string }).q);
    if (artists && isError(artists)) return send(reply, artists);
    if (!artists) {
      return reply.code(503).send({ error: 'Genius is not configured', code: 'catalog_genius_unavailable' });
    }
    return { artists };
  } catch {
    return upstream(reply);
  }
}

export async function geniusPhoto(request: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await copyGeniusArtistPhoto(request.userId as string, (request.body as { geniusId: number }).geniusId);
    return isError(result) ? send(reply, result) : result;
  } catch {
    return upstream(reply);
  }
}

export async function geniusAlbums(request: FastifyRequest, reply: FastifyReply) {
  try {
    const albums = await searchGeniusAlbums(request.userId as string, (request.query as { q: string }).q);
    if (albums && isError(albums)) return send(reply, albums);
    if (!albums) {
      return reply.code(503).send({ error: 'Genius is not configured', code: 'catalog_genius_unavailable' });
    }
    return { albums };
  } catch {
    return upstream(reply);
  }
}

export async function geniusAlbumCover(request: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await copyGeniusAlbumCover(request.userId as string, (request.body as { geniusId: number }).geniusId);
    return isError(result) ? send(reply, result) : result;
  } catch {
    return upstream(reply);
  }
}

export async function projectCovers(request: FastifyRequest, reply: FastifyReply) {
  const { artistId, title } = request.query as { artistId: string; title: string };
  const covers = await listProjectCoverProposals(request.userId as string, artistId, title);
  return isError(covers) ? send(reply, covers) : { covers };
}

export async function projectCoverCopy(request: FastifyRequest, reply: FastifyReply) {
  const { artistId, title, publicId } = request.body as { artistId: string; title: string; publicId: string };
  const result = await copyProjectCover(request.userId as string, artistId, title, publicId);
  return isError(result) ? send(reply, result) : result;
}