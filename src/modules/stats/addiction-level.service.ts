import AddictionLevel, {
  type IAddictionLevel,
  type ILevelRequirements,
} from './addiction-level.model.js';
import SeedMarker from '../../db/seed-marker.model.js';

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
    id: 'hidden_track_after_ten_minutes_of_silence',
    title: { en: 'Hidden Track After Ten Minutes of Silence', es: 'Tema Oculto Tras Diez Minutos de Silencio' },
    description: { en: 'You waited, and nobody else did', es: 'Tú esperaste, y nadie más lo hizo' },
    requirements: { syncedLines: 25000, musicSyncedMinutes: 2500 },
    order: 13,
  },
  {
    id: 'posthumous_release_pending',
    title: { en: 'Posthumous Release Pending', es: 'Lanzamiento Póstumo en Camino' },
    description: { en: 'Greatest Hits, Vol. 9', es: 'Grandes Éxitos, Vol. 9' },
    requirements: { syncedLines: 15000, musicSyncedMinutes: 1500 },
    order: 12.5,
  },
  {
    id: 'dead_mic_still_syncing',
    title: { en: 'Dead Mic, Still Syncing', es: 'Micrófono Muerto, Sigo Sincronizando' },
    description: { en: 'The band left in 2019', es: 'La banda se fue en 2019' },
    requirements: { syncedLines: 12000, musicSyncedMinutes: 1200 },
    order: 12.2,
  },
  {
    id: 'industry_plant_supreme',
    title: { en: 'Industry Plant Supreme', es: 'Planta de la Industria Suprema' },
    description: { en: 'The Peak (God tier - corrupt success)', es: 'La Cima (Nivel Dios - éxito corrupto)' },
    requirements: { syncedLines: 10000, musicSyncedMinutes: 1000 },
    order: 12,
  },
  {
    id: 'high_on_my_own_back_catalogue',
    title: { en: 'High on My Own Back Catalogue', es: 'Drogado con Mi Propio Catálogo' },
    description: { en: 'Streams his own B-sides at 3 a.m.', es: 'Escucha sus propios lados B a las 3 a.m.' },
    requirements: { syncedLines: 8500, musicSyncedMinutes: 900 },
    order: 11.8,
  },
  {
    id: 'second_mortgage_on_the_masters',
    title: { en: 'Second Mortgage on the Masters', es: 'Segunda Hipoteca Sobre las Cintas Maestras' },
    description: { en: 'Collateral: the unreleased album', es: 'Garantía: el álbum inédito' },
    requirements: { syncedLines: 7000, musicSyncedMinutes: 800 },
    order: 11.5,
  },
  {
    id: 'sold_out_literally',
    title: { en: 'Sold Out (Literally)', es: 'Vendido (Literalmente)' },
    description: { en: 'Arena success (but compromised)', es: 'Éxito de estadios (pero comprometido)' },
    requirements: { syncedLines: 5000, musicSyncedMinutes: 600 },
    order: 11,
  },
  {
    id: 'sold_the_gear_for_one_more_take',
    title: { en: 'Sold the Gear for One More Take', es: 'Vendí el Equipo por Una Toma Más' },
    description: { en: 'The synth went first', es: 'El sintetizador fue el primero' },
    requirements: { syncedLines: 4200, musicSyncedMinutes: 520 },
    order: 10.8,
  },
  {
    id: 'tour_bus_tenant',
    title: { en: 'Tour Bus Tenant', es: 'Inquilino del Bus de Gira' },
    description: { en: 'Lives on the road, syncs in the bunk', es: 'Vive en la carretera, sincroniza en la litera' },
    requirements: { syncedLines: 3500, musicSyncedMinutes: 450 },
    order: 10.5,
  },
  {
    id: 'sleeping_in_the_studio_closet',
    title: { en: 'Sleeping in the Studio Closet', es: 'Durmiendo en el Armario del Estudio' },
    description: { en: 'Rent is a social construct', es: 'El alquiler es un invento social' },
    requirements: { syncedLines: 2500, musicSyncedMinutes: 360 },
    order: 10.2,
  },
  {
    id: 'manager_takes_twenty_percent_of_my_soul',
    title: { en: 'Manager Takes 20% of My Soul', es: 'El Manager se Lleva el 20% de mi Alma' },
    description: { en: 'Professional exploitation', es: 'Explotación profesional' },
    requirements: { syncedLines: 2000, musicSyncedMinutes: 300 },
    order: 10,
  },
  {
    id: 'cut_with_autotune',
    title: { en: 'Cut With Autotune', es: 'Cortado con Autotune' },
    description: { en: 'Pure take? Not since the third batch', es: '¿Toma pura? No desde la tercera tanda' },
    requirements: { syncedLines: 1500, musicSyncedMinutes: 210 },
    order: 9.7,
  },
  {
    id: 'viral_for_the_wrong_reasons',
    title: { en: 'Viral for the Wrong Reasons', es: 'Viral por las Razones Equivocadas' },
    description: { en: 'A 3-second clip, out of context', es: 'Un clip de 3 segundos, fuera de contexto' },
    requirements: { syncedLines: 1200, musicSyncedMinutes: 170, starsReceived: 250 },
    order: 9.5,
  },
  {
    id: 'compulsive_compulsive',
    title: { en: 'Compulsive-Compulsive', es: 'Compulsivo-Compulsivo' },
    description: { en: 'Obsessive perfectionism', es: 'Perfeccionismo obsesivo' },
    requirements: { syncedLines: 1000, musicSyncedMinutes: 150 },
    order: 9,
  },
  {
    id: 'syllable_surgeon',
    title: { en: 'Syllable Surgeon', es: 'Cirujano de Sílabas' },
    description: { en: 'Times words, not lines', es: 'Sincroniza palabras, no líneas' },
    requirements: { syncedLines: 600, musicSyncedMinutes: 90, wordsTimestamped: 3000 },
    order: 8.7,
  },
  {
    id: 'liner_notes_loiterer',
    title: { en: 'Liner Notes Loiterer', es: 'Merodeador de Créditos del Disco' },
    description: { en: 'Reads the credits for fun', es: 'Lee los créditos por diversión' },
    requirements: { syncedLines: 750, musicSyncedMinutes: 110 },
    order: 8.5,
  },
  {
    id: 'bar_closes_mic_doesnt',
    title: { en: "Bar Closes, Mic Doesn't", es: 'El Bar Cierra, el Micrófono No' },
    description: { en: 'Last call was hours ago', es: 'La última ronda fue hace horas' },
    requirements: { syncedLines: 650, musicSyncedMinutes: 100, karaokeLines: 150 },
    order: 8.3,
  },
  {
    id: 'metrics_meth_head',
    title: { en: 'Metrics Meth Head', es: 'Adicto a las Métricas' },
    description: { en: 'Numbers over art', es: 'Los números por encima del arte' },
    requirements: { syncedLines: 500, musicSyncedMinutes: 75 },
    order: 8,
  },
  {
    id: 'scrubbing_the_same_four_bars',
    title: { en: 'Scrubbing the Same Four Bars', es: 'Rebobinando los Mismos Cuatro Compases' },
    description: { en: 'Rewinds until the sound stops meaning anything', es: 'Rebobina hasta que el sonido deja de significar algo' },
    requirements: { syncedLines: 350, musicSyncedMinutes: 55 },
    order: 7.5,
  },
  {
    id: 'stream_count_stalker',
    title: { en: 'Stream Count Stalker', es: 'Acosador de Reproducciones' },
    description: { en: 'The modern equivalent', es: 'El equivalente moderno' },
    requirements: { syncedLines: 250, musicSyncedMinutes: 40 },
    order: 7,
  },
  {
    id: 'jonesing_for_the_bridge',
    title: { en: 'Jonesing for the Bridge', es: 'Muriendo por el Puente' },
    description: { en: 'Only the bridge hits right', es: 'Solo el puente te pega bien' },
    requirements: { syncedLines: 175, musicSyncedMinutes: 30 },
    order: 6.5,
  },
  {
    id: 'crate_digging_degenerate',
    title: { en: 'Crate Digging Degenerate', es: 'Degenerado Buscador de Discos' },
    description: { en: 'Serious collector level', es: 'Nivel de coleccionista serio' },
    requirements: { syncedLines: 100, musicSyncedMinutes: 20 },
    order: 6,
  },
  {
    id: 'encore_enabler',
    title: { en: 'Encore Enabler', es: 'Pidiendo Otra Más' },
    description: { en: 'Just one more tune', es: 'Solo una canción más' },
    requirements: { syncedLines: 75, musicSyncedMinutes: 15 },
    order: 5.5,
  },
  {
    id: 'one_hit_blunder',
    title: { en: 'One Hit Blunder', es: 'Un Solo Golpe de Suerte' },
    description: { en: 'One moment of glory, accidental', es: 'Un momento de gloria, accidental' },
    requirements: { syncedLines: 50, musicSyncedMinutes: 10 },
    order: 5,
  },
  {
    id: 'soundcheck_survivor',
    title: { en: 'Soundcheck Survivor', es: 'Sobreviviente de Prueba de Sonido' },
    description: { en: 'Check one, two… for the 40th time', es: 'Probando, uno, dos… por la vez cuarenta' },
    requirements: { syncedLines: 35, musicSyncedMinutes: 7 },
    order: 4.5,
  },
  {
    id: 'mixing_while_drunk_again',
    title: { en: 'Mixing While Drunk (Again)', es: 'Mezclando Borracho (Otra Vez)' },
    description: { en: 'Functional addiction', es: 'Adicción funcional' },
    requirements: { syncedLines: 20, musicSyncedMinutes: 5 },
    order: 4,
  },
  {
    id: 'twitchy_between_takes',
    title: { en: 'Twitchy Between Takes', es: 'Inquieto Entre Tomas' },
    description: { en: 'Hands shaking until the next sync', es: 'Las manos tiemblan hasta la próxima sincronización' },
    requirements: { syncedLines: 10, musicSyncedMinutes: 2 },
    order: 3.5,
  },
  {
    id: 'pay_to_play_professional',
    title: { en: 'Pay-to-Play Professional', es: 'Profesional del Pago por Tocar' },
    description: { en: 'Desperate hustler', es: 'Buscavidas desesperado' },
    requirements: { syncedLines: 5, totalProjects: 3 },
    order: 3,
  },
  {
    id: 'just_one_verse_i_swear',
    title: { en: 'Just One Verse, I Swear', es: 'Solo un Verso, lo Juro' },
    description: { en: 'The first one is always "just to try it"', es: 'La primera siempre es "solo para probar"' },
    requirements: { syncedLines: 3 },
    order: 2.5,
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

const levelMarkerId = (id: string): string => `addiction_level:${id}`;

/**
 * Seeds default addiction levels on startup (plugins/cron.ts). Idempotent per
 * level, keyed by `id`:
 * - existing levels are never modified ($setOnInsert only), so admin edits survive;
 * - each seeded default gets a SeedMarker, so a level an admin later deletes is
 *   not resurrected on the next restart;
 * - defaults added to DEFAULT_LEVELS later are inserted into existing databases.
 * Returns the number of levels inserted.
 */
export async function seedAddictionLevels(): Promise<number> {
  const markers = await SeedMarker.find({ _id: { $in: DEFAULT_LEVELS.map(l => levelMarkerId(l.id)) } })
    .select('_id')
    .lean<{ _id: string }[]>();
  const seeded = new Set(markers.map(m => m._id));
  const pending = DEFAULT_LEVELS.filter(l => !seeded.has(levelMarkerId(l.id)));
  if (pending.length === 0) return 0;

  const result = await AddictionLevel.bulkWrite(
    pending.map(({ id, ...fields }) => ({
      updateOne: { filter: { id }, update: { $setOnInsert: fields }, upsert: true },
    })),
    { ordered: false }
  );
  // Markers are written after the levels: if this step fails, the next run
  // re-upserts (a no-op for levels that now exist) and retries the markers.
  await SeedMarker.bulkWrite(
    pending.map(l => ({
      updateOne: { filter: { _id: levelMarkerId(l.id) }, update: { $setOnInsert: { _id: levelMarkerId(l.id) } }, upsert: true },
    })),
    { ordered: false }
  );
  if (result.upsertedCount > 0) invalidateLevelCache();
  return result.upsertedCount;
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
    { returnDocument: 'after' }
  ).lean<IAddictionLevel>();
  invalidateLevelCache();
  return level;
}

export async function deleteLevel(id: string): Promise<boolean> {
  const result = await AddictionLevel.deleteOne({ id });
  invalidateLevelCache();
  return (result.deletedCount ?? 0) > 0;
}
