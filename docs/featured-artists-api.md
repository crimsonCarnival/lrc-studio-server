# Featured artists — API contract (server → client)

A song has an ordered list of **artist credits**, each `primary` or `featured`. The server also keeps a
**derived** display string, `metadata.songArtist` (e.g. `Drake feat. Rihanna & Kanye`), so every existing
reader (cards, search, OG, slug) keeps working. **`songArtist` is read-only now — it is no longer accepted as input.**

> **Breaking change.** `songArtist` was removed from `ProjectMetadataInput`. A client that still sends it gets a
> GraphQL validation error. There is no legacy-string transition: deploy the client change with (or right after) the server.
> Legacy rows keep their `songArtist` text until `scripts/migrate-artists.ts` converts them.

## 1. Shared parser / formatter — mirror exactly

Copy **`src/utils/artists.ts`** from the server verbatim (it has no imports). Its test file
`src/utils/artists.test.ts` is the behavioural spec; port it too.

### Formatter (`formatArtistDisplay`)
| Credits | Result |
|---|---|
| 1 primary | `A` |
| 2 primaries | `A & B` |
| 3+ primaries | `A, B & C` |
| primaries + 1 featured | `P feat. A` |
| … 2 featured | `P feat. A & B` |
| … 3+ featured | `P feat. A, B & C` |
| featured only | `feat. A` |

Primaries and featured are each sorted by `order`. `formatTitleWithFeatured(title, credits)` → `Title (feat. A & B)` (title unchanged when there are no featured).

### Parser (`parseArtists(artistText, titleText?)`) → `{ credits, title, flags }`
- Markers (case-insensitive): `feat.` `feat` `ft.` `ft` `featuring`; `with` **only inside `()` / `[]`**. Brackets can be nested; inside or outside brackets.
- Featured names split on `,` `&` ` and ` ` x ` ` × `.
- The artist string's remainder (the primaries) is split on the same separators.
- `title` is the title **without** the feat. segment, or `null` if nothing was extracted from it.
- Duplicates are removed case-insensitively (primary wins).
- `credits` are primaries first, then featured; `order` = index.

### Flags — the UI must let the user confirm these (the parser never guesses)
| Code | Meaning | Suggested UI |
|---|---|---|
| `ambiguous_separator` | Split on `&` / `and` / `x`; may be one act (*Simon & Garfunkel*). `text` = the segment | Chips with a "merge into one artist" action |
| `weak_marker` | Bare `ft` / `feat` without a dot outside brackets (*Ft Lauderdale*) | Ask before applying |
| `empty_feat_segment` | A marker with no names; text left untouched | Leave as typed, warn |
| `unbalanced_bracket` | `Song (feat. A` | Leave as typed, warn |
| `duplicate_removed` | A repeated name was dropped | Informational |

The server exposes the same parser as a query so the UI can stay in sync without copying logic (§4).

## 2. Reading and writing credits (GraphQL)

```graphql
enum ArtistRole { primary featured }
type ArtistCredit { artistId: ID, name: String!, role: ArtistRole!, order: Int! }   # on ProjectMetadata.artists: [ArtistCredit!]!
input ArtistCreditInput { name: String!, role: ArtistRole! }                          # on ProjectMetadataInput.artists: [ArtistCreditInput!]
```

- **Read:** `metadata { songArtist artists { artistId name role order } }`. `artists` is always a list (`[]` on legacy rows); `songArtist` is the display string.
- **Create / update:** send `metadata: { artists: [{ name, role }, …] }`.
  - **Omitted** (`artists` not in the object): stored credits are kept as they are. Metadata edits that don't touch artists are safe.
  - **`[]`**: clears the artists (and `songArtist`).
  - **List order is the display order** within each role; the server returns primaries first, then featured, numbered `order` 0…n.
  - `artistId` is never accepted from the client; it's resolved server-side within the owner's own records.
- Names are trimmed and whitespace-collapsed; HTML is stripped.
- A project still needs a title, song name or **artist** (`project_identity_required` otherwise).
- The URL slug now includes the display string, so a featured artist gives `/<owner>/projects/drake-feat-rihanna-creep-<id>`. Build it the same way as before from `songArtist` (it already carries `feat.`), or just use `slug`.

### Validation errors
Returned as GraphQL errors with `extensions: { code, status: 422 }`:

| `code` | Message | When |
|---|---|---|
| `artists_invalid` | artists must be a list / Each artist must be an object | Wrong shape |
| `artist_role_invalid` | Artist role must be "primary" or "featured" | Bad role |
| `artist_name_empty` | Artist names cannot be empty | Blank after trimming |
| `artist_name_too_long` | Artist names are limited to 300 characters | > 300 |
| `artists_too_many` | A song can have at most 10 artists | > 10 total |
| `artist_duplicate` | "X" is listed more than once | Case-insensitive duplicate (any roles) |
| `artist_primary_required` | At least one primary artist is required | Non-empty list with no primary |

Limits (`ARTIST_LIMITS`): max **10** credits, name ≤ **300** characters. Validate client-side with `validateArtistCredits` from the shared file to show the same messages.

## 3. Autocomplete (own library only)

```graphql
query { myArtistSuggestions(prefix: "dr", limit: 10, offset: 0) { total items { id name } } }
```
- Authenticated users only (401 otherwise). Searches **the caller's own** artist names — names they have credited before — never anyone else's.
- Case-insensitive **prefix** match, sorted A→Z. `limit` defaults to 10, max **20**; `offset` for paging. An empty prefix lists everything.
- The prefix is matched as plain text (no wildcards/regex).
- Names stay in the list after a project stops using them (it is a history, like the music-library autofill).

## 4. Parse helper (for the UI)

```graphql
query { parseArtists(artist: "Drake ft. Rihanna, Kanye", title: "Song (feat. A)") {
  display title artists { name role order } flags { code source text } } }
```
Pure (no auth needed), input capped at 1000 characters each. Use it to pre-fill the artist editor from a pasted string, a provider lookup (Spotify-style results arrive as `A, B`), or an imported file.

## 5. LRC export / import (REST)

**`POST /lyrics/compile/lrc`** — new optional fields:
- `metadata.artists`: `[{ name, role }]`. When present, `[ar:]` = `formatArtistDisplay(credits)` (overrides `metadata.ar`).
- `includeFeaturedInTitle` (boolean): when `true`, `[ti:]` becomes `Title (feat. A & B)`; when `false`, `[ti:]` stays the plain title. **If the body omits it**, a signed-in request uses the user's saved `settings.export.includeFeaturedInTitle`; anonymous requests and users who never set it get `false`. An explicit `true`/`false` in the body always wins. The request needs the session cookie for the saved setting to apply.
- **Persisted setting:** `settings { export { includeFeaturedInTitle } }` (`Boolean`, reads as `false` when never set) and `updateSettings(input: { export: { includeFeaturedInTitle: true } })`. Like the other export settings, it follows the user across devices.
- Invalid credits → `422 { error, code }` with the codes above. Without `metadata.artists` the old `ar` / `ti` strings pass through unchanged.

**`POST /lyrics/parse`** — response now also includes (for `.lrc` / `.txt`, not `.srt`):
```jsonc
{ "lines": [...], "detectedFormat": "lrc", "count": 12,
  "metadata": { "ti": "Song (feat. B)", "ar": "A", "al": "Album" },          // header tags found, trimmed; {} if none
  "artists": { "credits": [{ "name": "A", "role": "primary", "order": 0 }, …],
               "title": "Song",                                              // cleaned title, or null
               "flags": [{ "code": "ambiguous_separator", "source": "artist", "text": "A & B" }],
               "display": "A feat. B" }                                       // null when the file has no [ar:]/[ti:]
}
```
Show the flags to the user before applying the credits.

## 6. Migration (server-side, one-off)

`pnpm tsx scripts/migrate-artists.ts` — **report only** by default; `--write` applies; `--include-ambiguous` also applies `&`/`and`/`x` and bare `ft` rows (split as written); `--report file.json` saves the full report.
A title / song name loses its `feat.` segment only when that segment was moved into `artists`, and is never emptied. Re-runs are safe.
Malformed rows (empty marker, unbalanced bracket, > 10 names…) are never applied.

## 7. Notes for the client task
- The music-library autofill (`myMusicLibrary`) now stores **primary** artists only.
- Lyrics search (`/lyrics/search`, `/lyrics/extract`) and track-metadata lookup take a single artist string: send the **primary** names (`joinNames` of the primaries), not the display string.
- Atlas Search: no index change is needed. the search paths already include `metadata.songArtist`, which carries every artist, featured included (the regex fallback uses it too).
