import type { FastifyInstance } from 'fastify';
import Project from '../projects/project.model.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOgHtml(params: {
  title: string;
  description: string;
  image: string;
  projectUrl: string;
}): string {
  const { title, description, image, projectUrl } = params;
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const i = escapeHtml(image);
  const u = escapeHtml(projectUrl);

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<title>${t}</title>
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${i}">
<meta property="og:url" content="${u}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="LRC Studio">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">
<meta http-equiv="refresh" content="0; url=${u}">
</head><body>
<script>window.location.replace("${u.replace(/"/g, '\\"')}");</script>
<p><a href="${u}">View on LRC Studio</a></p>
</body></html>`;
}

export default async function ogRoutes(fastify: FastifyInstance): Promise<void> {
  const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN
    || process.env.CORS_ORIGIN?.split(',')[0]?.trim()
    || '';

  fastify.get<{ Params: { projectId: string } }>(
    '/project/:projectId',
    async (request, reply) => {
      const { projectId } = request.params;

      const project = await Project.findOne({ projectId, public: true })
        .select('title metadata coverImage userId')
        .populate('userId', 'accountName displayName')
        .lean() as any;

      if (!project) {
        return reply.code(404).send('Not found');
      }

      const songName = project.metadata?.songName || project.title || 'Untitled';
      const artist = project.metadata?.songArtist ? ` · ${project.metadata.songArtist}` : '';
      const creator = project.userId?.displayName || project.userId?.accountName || 'Unknown';
      const title = `${songName}${artist} — LRC Studio`;
      const description = `Synced lyrics by ${creator}`;
      const image = project.coverImage || project.metadata?.albumArt || '';
      const projectUrl = `${CLIENT_ORIGIN}/project/${projectId}`;

      return reply
        .code(200)
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'public, max-age=300')
        .send(buildOgHtml({ title, description, image, projectUrl }));
    }
  );
}
