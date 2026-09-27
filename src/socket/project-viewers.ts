/**
 * Who is looking at which public project, right now.
 *
 * Deliberately in-memory and dependency-free (no Socket.IO, no Mongoose): this
 * module is pure bookkeeping, which is what makes it unit-testable and cheap.
 * The Socket.IO wiring lives in plugins/socket.ts.
 *
 * SINGLE-INSTANCE ONLY. With more than one server process, an owner sees only
 * the viewers connected to their own instance. Same constraint as
 * asr/job.store.ts and the requests pending queue — see
 * .claude/rules/technical-debt.md.
 */

/** publicId -> socketId -> the viewer behind that socket (userId absent = anonymous). */
const viewersByProject = new Map<string, Map<string, { userId?: string }>>();
/** socketId -> the set of projects that socket is viewing, so disconnect is O(projects-of-socket). */
const projectsBySocket = new Map<string, Set<string>>();

/**
 * Upper bound on an incoming publicId. Real ones are nanoid(10); the slack is
 * for legacy or future formats. Anything longer is refused rather than becoming
 * a Map key — an unbounded client-supplied key is a memory-growth vector.
 */
export const MAX_PUBLIC_ID_LENGTH = 32;

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Upper bound on distinct projects one socket may register as a viewer of.
 * publicId is client-supplied and viewers:join requires no authentication, so
 * without a cap a single connection could loop over millions of distinct
 * valid-looking ids and grow both viewersByProject and projectsBySocket
 * without bound. 20 is far above anything a real client reaches — the page
 * watches one project at a time and leaves it on navigation.
 */
export const MAX_PROJECTS_PER_SOCKET = 20;

/** Validates a client-supplied project id before it reaches a Map or a query. */
export function isValidPublicId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PUBLIC_ID_LENGTH &&
    PUBLIC_ID_PATTERN.test(value)
  );
}

export function addViewer(publicId: string, socketId: string, userId?: string): void {
  const projects = projectsBySocket.get(socketId);
  // Cap enforced per-socket, not globally: a socket already tracking its max
  // and joining a new project is refused, but re-joining a project it already
  // tracks (e.g. a duplicate viewers:join) must still succeed below.
  if (projects && projects.size >= MAX_PROJECTS_PER_SOCKET && !projects.has(publicId)) return;

  let sockets = viewersByProject.get(publicId);
  if (!sockets) {
    sockets = new Map();
    viewersByProject.set(publicId, sockets);
  }
  sockets.set(socketId, userId ? { userId } : {});

  let socketProjects = projects;
  if (!socketProjects) {
    socketProjects = new Set();
    projectsBySocket.set(socketId, socketProjects);
  }
  socketProjects.add(publicId);
}

export function removeViewer(publicId: string, socketId: string): void {
  const sockets = viewersByProject.get(publicId);
  if (sockets) {
    sockets.delete(socketId);
    // Drop the project entry entirely when empty, so an idle server does not
    // accumulate one Map per project ever visited.
    if (sockets.size === 0) viewersByProject.delete(publicId);
  }

  const projects = projectsBySocket.get(socketId);
  if (projects) {
    projects.delete(publicId);
    if (projects.size === 0) projectsBySocket.delete(socketId);
  }
}

/**
 * Remove a socket from every project it was viewing. Returns those publicIds so
 * the caller can re-emit each affected owner's roster. Used on disconnect, which
 * is the common case — browsers rarely get to send a clean leave.
 */
export function removeSocket(socketId: string): string[] {
  const projects = projectsBySocket.get(socketId);
  if (!projects) return [];
  const affected = Array.from(projects);
  for (const publicId of affected) {
    const sockets = viewersByProject.get(publicId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) viewersByProject.delete(publicId);
    }
  }
  projectsBySocket.delete(socketId);
  return affected;
}

/**
 * Distinct viewers on a project: one entry per signed-in person (so three tabs
 * are one avatar), plus a count of the sockets with no identity.
 */
export function getViewerSummary(publicId: string): { userIds: string[]; anonymousCount: number } {
  const sockets = viewersByProject.get(publicId);
  if (!sockets) return { userIds: [], anonymousCount: 0 };

  const userIds = new Set<string>();
  let anonymousCount = 0;
  for (const viewer of sockets.values()) {
    if (viewer.userId) userIds.add(viewer.userId);
    else anonymousCount++;
  }
  return { userIds: Array.from(userIds), anonymousCount };
}

/** Test-only: drop all state between cases. */
export function resetViewers(): void {
  viewersByProject.clear();
  projectsBySocket.clear();
}
