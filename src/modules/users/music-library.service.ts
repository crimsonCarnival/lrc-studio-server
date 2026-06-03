import User from '../../db/user.model.js';

interface MusicLibraryEntry {
  artist: string;
  album: string;
  genre?: string;
  language?: string;
  trackCount?: number | null;
}

const MAX_ENTRIES = 100;

export async function upsertMusicLibraryEntry(
  userId: string,
  entry: MusicLibraryEntry
): Promise<void> {
  const artist = (entry.artist || '').trim();
  const album = (entry.album || '').trim();
  if (!artist && !album) return;

  const user = await User.findById(userId).select('musicLibrary').lean() as any;
  if (!user) return;

  const library: any[] = user.musicLibrary ?? [];
  const idx = library.findIndex(
    (e) =>
      e.artist?.toLowerCase() === artist.toLowerCase() &&
      e.album?.toLowerCase() === album.toLowerCase()
  );

  let newLibrary: any[];

  if (idx >= 0) {
    const existing = library[idx];
    const updated = {
      artist: existing.artist,
      album: existing.album,
      genre: entry.genre !== undefined ? entry.genre : existing.genre,
      language: entry.language !== undefined ? entry.language : existing.language,
      trackCount: entry.trackCount !== undefined ? entry.trackCount : existing.trackCount,
      updatedAt: new Date(),
    };
    newLibrary = [...library.slice(0, idx), ...library.slice(idx + 1), updated];
  } else {
    const base = library.length >= MAX_ENTRIES
      ? [...library].sort((a, b) => +new Date(a.updatedAt) - +new Date(b.updatedAt)).slice(1)
      : library;
    newLibrary = [
      ...base,
      {
        artist,
        album,
        genre: entry.genre ?? '',
        language: entry.language ?? '',
        trackCount: entry.trackCount ?? null,
        updatedAt: new Date(),
      },
    ];
  }

  await User.updateOne({ _id: userId }, { $set: { musicLibrary: newLibrary } });
}
