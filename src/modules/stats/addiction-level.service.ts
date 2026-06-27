import AddictionLevel, {
  type IAddictionLevel,
  type ILevelRequirements,
} from '../../db/addiction-level.model.js';

// ─── Default seed data ────────────────────────────────────────────────────────
// Each level specifies only the stats it cares about.
// "Higher" levels are matched first by descending `order`.

export const DEFAULT_LEVELS: Array<{
  id: string;
  title: { en: string; es: string };
  description: { en: string; es: string };
  requirements: ILevelRequirements;
  order: number;
}> = [
  {
    id: 'industry_plant_supreme',
    title: { en: 'Industry Plant Supreme', es: 'Planta de la Industria Suprema' },
    description: { en: 'The Peak (God tier - corrupt success)', es: 'La Cima (Nivel Dios - éxito corrupto)' },
    requirements: { syncedLines: 10000, musicSyncedMinutes: 1000 },
    order: 12,
  },
  {
    id: 'sold_out_literally',
    title: { en: 'Sold Out (Literally)', es: 'Vendido (Literalmente)' },
    description: { en: 'Arena success (but compromised)', es: 'Éxito de estadios (pero comprometido)' },
    requirements: { syncedLines: 5000, musicSyncedMinutes: 600 },
    order: 11,
  },
  {
    id: 'manager_takes_twenty_percent_of_my_soul',
    title: { en: 'Manager Takes 20% of My Soul', es: 'El Manager se Lleva el 20% de mi Alma' },
    description: { en: 'Professional exploitation', es: 'Explotación profesional' },
    requirements: { syncedLines: 2000, musicSyncedMinutes: 300 },
    order: 10,
  },
  {
    id: 'compulsive_compulsive',
    title: { en: 'Compulsive-Compulsive', es: 'Compulsivo-Compulsivo' },
    description: { en: 'Obsessive perfectionism', es: 'Perfeccionismo obsesivo' },
    requirements: { syncedLines: 1000, musicSyncedMinutes: 150 },
    order: 9,
  },
  {
    id: 'metrics_meth_head',
    title: { en: 'Metrics Meth Head', es: 'Adicto a las Métricas' },
    description: { en: 'Numbers over art', es: 'Los números por encima del arte' },
    requirements: { syncedLines: 500, musicSyncedMinutes: 75 },
    order: 8,
  },
  {
    id: 'stream_count_stalker',
    title: { en: 'Stream Count Stalker', es: 'Acosador de Reproducciones' },
    description: { en: 'The modern equivalent', es: 'El equivalente moderno' },
    requirements: { syncedLines: 250, musicSyncedMinutes: 40 },
    order: 7,
  },
  {
    id: 'crate_digging_degenerate',
    title: { en: 'Crate Digging Degenerate', es: 'Degenerado Buscador de Discos' },
    description: { en: 'Serious collector level', es: 'Nivel de coleccionista serio' },
    requirements: { syncedLines: 100, musicSyncedMinutes: 20 },
    order: 6,
  },
  {
    id: 'one_hit_blunder',
    title: { en: 'One Hit Blunder', es: 'Un Solo Golpe de Suerte' },
    description: { en: 'One moment of glory, accidental', es: 'Un momento de gloria, accidental' },
    requirements: { syncedLines: 50, musicSyncedMinutes: 10 },
    order: 5,
  },
  {
    id: 'mixing_while_drunk_again',
    title: { en: 'Mixing While Drunk (Again)', es: 'Mezclando Borracho (Otra Vez)' },
    description: { en: 'Functional addiction', es: 'Adicción funcional' },
    requirements: { syncedLines: 20, musicSyncedMinutes: 5 },
    order: 4,
  },
  {
    id: 'pay_to_play_professional',
    title: { en: 'Pay-to-Play Professional', es: 'Profesional del Pago por Tocar' },
    description: { en: 'Desperate hustler', es: 'Buscavidas desesperado' },
    requirements: { syncedLines: 5, totalProjects: 3 },
    order: 3,
  },
  {
    id: 'unpaid_soundcloud_intern',
    title: { en: 'Unpaid SoundCloud Intern', es: 'Pasante No Remunerado de SoundCloud' },
    description: { en: 'Aspiring amateur', es: 'Amateur aspirante' },
    requirements: { syncedLines: 1 },
    order: 2,
  },
  {
    id: 'shower_singer_mold_issues',
    title: { en: 'Shower Singer (Mold Issues)', es: 'Cantante de Ducha (Con Problemas de Humedad)' },
    description: { en: 'Beginner with ego', es: 'Principiante con ego' },
    requirements: { totalProjects: 1 },
    order: 1,
  },
  {
    id: 'beat_deaf',
    title: { en: 'Beat Deaf', es: 'Sin Ritmo' },
    description: { en: 'The bottom', es: 'El fondo' },
    requirements: {},
    order: 0
  }
];

/**
 * Seeds default addiction levels. Uses $setOnInsert so admin edits
 * survive server restarts.
 */
export async function seedAddictionLevels(): Promise<void> {
  const existing = await AddictionLevel.countDocuments();
  if (existing > 0) return;

  for (const level of DEFAULT_LEVELS) {
    const { id, title, description, ...insertOnly } = level;
    await AddictionLevel.findOneAndUpdate(
      { id },
      {
        $setOnInsert: insertOnly,
        $set: { title, description },
      },
      { upsert: true, runValidators: false }
    );
  }
}

// ─── Stats snapshot used for level evaluation ─────────────────────────────────

export interface UserStatsSnapshot {
  syncedLines: number;
  karaokeLines: number;
  musicSyncedMinutes: number;
  publicProjects: number;
  starsReceived: number;
  wordsTimestamped: number;
  totalProjects: number;
}

// ─── Level evaluation ─────────────────────────────────────────────────────────

/** Returns true if the user's stats satisfy ALL non-zero requirements. */
function satisfies(stats: UserStatsSnapshot, req: ILevelRequirements): boolean {
  if ((req.syncedLines       ?? 0) > 0 && stats.syncedLines       < (req.syncedLines       ?? 0)) return false;
  if ((req.karaokeLines      ?? 0) > 0 && stats.karaokeLines      < (req.karaokeLines      ?? 0)) return false;
  if ((req.musicSyncedMinutes?? 0) > 0 && stats.musicSyncedMinutes< (req.musicSyncedMinutes?? 0)) return false;
  if ((req.publicProjects    ?? 0) > 0 && stats.publicProjects     < (req.publicProjects    ?? 0)) return false;
  if ((req.starsReceived     ?? 0) > 0 && stats.starsReceived      < (req.starsReceived     ?? 0)) return false;
  if ((req.wordsTimestamped  ?? 0) > 0 && stats.wordsTimestamped   < (req.wordsTimestamped  ?? 0)) return false;
  if ((req.totalProjects     ?? 0) > 0 && stats.totalProjects      < (req.totalProjects     ?? 0)) return false;
  return true;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cachedLevels: IAddictionLevel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

async function getLevelsSorted(): Promise<IAddictionLevel[]> {
  const now = Date.now();
  if (cachedLevels && now - cacheTimestamp < CACHE_TTL_MS) return cachedLevels;

  // Sort descending by order so we match the highest level first
  const levels = await AddictionLevel.find({})
    .sort({ order: -1 })
    .lean<IAddictionLevel[]>();

  cachedLevels = levels;
  cacheTimestamp = now;
  return levels;
}

export function invalidateLevelCache(): void {
  cachedLevels = null;
  cacheTimestamp = 0;
}

/**
 * Evaluates a user's stats against all levels (highest order first)
 * and returns the title of the first level all requirements are met.
 */
export async function getAddictionLevel(stats: UserStatsSnapshot): Promise<{ id: string, title: { en: string; es: string } }> {
  const levels = await getLevelsSorted();
  for (const level of levels) {
    if (satisfies(stats, level.requirements ?? {})) {
      return { id: level.id, title: level.title };
    }
  }
  // Fallback: level with order 0 always has empty requirements
  return levels.length > 0 
    ? { id: levels[levels.length - 1].id, title: levels[levels.length - 1].title }
    : { id: 'beat_deaf', title: { en: 'Beat Deaf', es: 'Sin Ritmo' } };
}

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

export async function getAllLevels(): Promise<IAddictionLevel[]> {
  return AddictionLevel.find({}).sort({ order: -1 }).lean<IAddictionLevel[]>();
}

export interface LevelInput {
  id: string;
  title: { en: string; es?: string };
  description?: { en: string; es?: string };
  requirements?: ILevelRequirements;
  order?: number;
}

export async function createLevel(input: LevelInput): Promise<IAddictionLevel> {
  const level = await AddictionLevel.create(input);
  invalidateLevelCache();
  return level.toObject() as IAddictionLevel;
}

export async function updateLevel(
  id: string,
  input: Partial<Omit<LevelInput, 'id'>>
): Promise<IAddictionLevel | null> {
  const level = await AddictionLevel.findOneAndUpdate(
    { id },
    { $set: input },
    { new: true }
  ).lean<IAddictionLevel>();
  invalidateLevelCache();
  return level;
}

export async function deleteLevel(id: string): Promise<boolean> {
  const result = await AddictionLevel.deleteOne({ id });
  invalidateLevelCache();
  return (result.deletedCount ?? 0) > 0;
}
