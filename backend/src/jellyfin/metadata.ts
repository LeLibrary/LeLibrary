// The metadata document the Jellyfin plugin reads: per title, with the
// episodes nested under their show.
//
// The plan is per file; the metadata is per title. This is the projection
// that makes the difference: one row per (title, episode) for the titles the
// setup's library holds, folded here into one entry per title.
//
// Pure functions only - no database, no network - so the shape can be pinned
// by tests.

// The same genre map the releases route uses: TMDB's canonical genre ids to
// names. A second map here would drift from it.
const { movieGenreNames, tvGenreNames } = require('../releases/genres.ts') as {
  movieGenreNames: (ids: unknown) => string[];
  tvGenreNames: (ids: unknown) => string[];
};

const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

// One row of the metadata projection, as the store reads it.
export interface MetadataRow {
  entity_key?: string | null;
  media_type?: string | null;
  tmdb_id?: number | null;
  imdb_id?: string | null;
  tvdb_id?: number | null;
  title?: string | null;
  year?: number | null;
  poster?: string | null;
  logo?: string | null;
  genres?: string[] | null;
  metadata?: unknown;
  genre_ids?: number[] | null;
  overview?: string | null;
  runtime?: number | null;
  vote_average?: number | null;
  vote_count?: number | null;
  certification?: string | null;
  release_date?: string | null;
  backdrop_path?: string | null;
  season?: number | null;
  episode?: number | null;
  episode_title?: string | null;
  episode_overview?: string | null;
  episode_runtime?: number | null;
  air_date?: string | null;
  image?: string | null;
}

export interface MetadataEpisode {
  title?: string | null;
  overview?: string | null;
  runtime?: number | null;
  airDate?: string | null;
  still?: string | null;
}

export interface MetadataTitle {
  kind: string;
  title?: string | null;
  year?: number | null;
  overview?: string | null;
  runtime?: number | null;
  genres?: string[];
  rating?: number | null;
  voteCount?: number | null;
  certification?: string | null;
  releaseDate?: string | null;
  poster?: string | null;
  backdrop?: string | null;
  logo?: string | null;
  episodes?: Record<string, MetadataEpisode>;
}

export interface MetadataDocument {
  schemaVersion: number;
  generatedAt: string;
  titles: Record<string, MetadataTitle>;
}

export interface MetadataInput {
  rows?: MetadataRow[] | null;
  now?: number | null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// A date column. node-postgres parses a `date` into a JS Date, so a string-only
// check silently drops every release and air date.
function dateOrNull(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return textOrNull(value);
}

// The show overview lives in the identity's metadata blob, which the library
// filled from TVDB. The TMDB facts are the other source; a title has one or the
// other until the facts fill has run for it.
function overviewOf(row: MetadataRow): string | null {
  const fromFacts = textOrNull(row.overview);
  if (fromFacts) return fromFacts;
  const metadata = row.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? textOrNull((metadata as Record<string, unknown>).overview)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// A film is a film and a show is a show, whatever the library calls it.
function kindOf(mediaType: string | null | undefined): string {
  return mediaType === 'movie' ? 'movie' : 'tv';
}

// The key a title is found by. A film and a show that share a TMDB id must
// not collide, so the kind is part of it.
function keyFor(kind: string, row: MetadataRow): string | null {
  if (row.tmdb_id) return `${kind}:${row.tmdb_id}`;
  if (row.imdb_id) return `${kind}:${row.imdb_id}`;
  // Namespaced: TMDB and TVDB ids are both small integers, so a bare TVDB id
  // would collide with another title's TMDB id.
  if (row.tvdb_id) return `${kind}:tvdb:${row.tvdb_id}`;
  return null;
}

function backdropUrl(path: unknown): string | null {
  const value = textOrNull(path);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${TMDB_IMAGE}/w1280${value.startsWith('/') ? '' : '/'}${value}`;
}

// The fields a title may carry, in the order they are written.
const TITLE_FIELDS = [
  'title', 'year', 'overview', 'runtime', 'genres', 'rating', 'voteCount',
  'certification', 'releaseDate', 'poster', 'backdrop', 'logo',
] as const;

type TitleField = (typeof TITLE_FIELDS)[number];

const FIELD_VALUES: Record<TitleField, (title: MetadataTitle) => unknown> = {
  title: (t) => t.title,
  year: (t) => t.year,
  overview: (t) => t.overview,
  runtime: (t) => t.runtime,
  genres: (t) => t.genres,
  rating: (t) => t.rating,
  voteCount: (t) => t.voteCount,
  certification: (t) => t.certification,
  releaseDate: (t) => t.releaseDate,
  poster: (t) => t.poster,
  backdrop: (t) => t.backdrop,
  logo: (t) => t.logo,
};

function buildMetadata(input: MetadataInput): { document: MetadataDocument; skipped: number } {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const now = input?.now != null ? input.now : Date.now();
  const titles = new Map<string, MetadataTitle>();
  let skipped = 0;

  for (const row of rows) {
    if (!row) continue;
    const kind = kindOf(row.media_type);
    const key = keyFor(kind, row);
    if (!key) {
      // A title with no id cannot be found again by anyone.
      skipped += 1;
      continue;
    }

    let title = titles.get(key);
    if (!title) {
      const ids = Array.isArray(row.genre_ids) ? row.genre_ids : [];
      const genres = ids.length
        ? (kind === 'movie' ? movieGenreNames(ids) : tvGenreNames(ids))
        : (Array.isArray(row.genres) ? row.genres : []);
      title = {
        kind,
        title: textOrNull(row.title),
        year: numberOrNull(row.year),
        overview: overviewOf(row),
        runtime: numberOrNull(row.runtime),
        genres,
        rating: typeof row.vote_average === 'number' && Number.isFinite(row.vote_average) ? row.vote_average : null,
        voteCount: numberOrNull(row.vote_count),
        certification: textOrNull(row.certification),
        releaseDate: dateOrNull(row.release_date),
        poster: textOrNull(row.poster),
        backdrop: backdropUrl(row.backdrop_path),
        logo: textOrNull(row.logo),
        episodes: {},
      };
      titles.set(key, title);
    }

    // The episode this row carries, when it carries one.
    if (row.season != null && row.episode != null) {
      const episodeTitle = textOrNull(row.episode_title);
      const episodeOverview = textOrNull(row.episode_overview);
      // An empty episode is worse than no episode: the plugin would blank a
      // title it already has.
      if (episodeTitle || episodeOverview) {
        title.episodes![`${row.season}:${row.episode}`] = {
          title: episodeTitle,
          overview: episodeOverview,
          runtime: numberOrNull(row.episode_runtime),
          airDate: dateOrNull(row.air_date),
          still: textOrNull(row.image),
        };
      }
    }
  }

  // A field the library does not have is left out entirely, never null: the
  // plugin must be able to tell "no overview" from "an empty one".
  const document: MetadataDocument = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    titles: {},
  };
  for (const [key, title] of titles) {
    const out: MetadataTitle = { kind: title.kind };
    for (const field of TITLE_FIELDS) {
      const value = FIELD_VALUES[field](title);
      if (value === null || value === undefined) continue;
      if (Array.isArray(value) && !value.length) continue;
      Object.assign(out, { [field]: value });
    }
    if (title.episodes && Object.keys(title.episodes).length) out.episodes = title.episodes;
    document.titles[key] = out;
  }

  return { document, skipped };
}

export interface MetadataApi {
  buildMetadata: (input: MetadataInput) => { document: MetadataDocument; skipped: number };
}

module.exports = { buildMetadata } satisfies MetadataApi;
