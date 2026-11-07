'use strict';
// One id language for watch history, whatever namespace a title arrived in.
//
// Nuvio content ids can be LeLibrary library ids (`torbox:{type}:{tmdbId}`),
// discovery ids (`tt...`), `tmdb:...`, `kitsu:...` and more; catalogue rows
// carry `torbox:` ids (library) or `tt` ids (discovery, curated, personal
// rows) plus, often, a `tmdbId`. Everything maps to canonical keys:
//   {type}:tmdb:{id}           a film or a show
//   {type}:imdb:{tt}           its IMDb alias (same title)
//   series:tmdb:{id}:s{S}e{E}  one episode
// A title is matched when any of its keys is in the set, so Hide watched
// works on library rows and discovery rows alike. Pure: no network.

export type MediaType = 'movie' | 'series';

export interface ParsedId {
  type: MediaType;
  tmdb: number | null;
  imdb: string | null;
  // Another namespace (kitsu, mal, anilist...): kept as an alias key only.
  other: string | null;
  season: number | null;
  episode: number | null;
}

const IMDB = /^tt\d{5,12}$/;

function mediaType(value: unknown): MediaType | null {
  const raw = String(value || '').toLowerCase();
  if (raw === 'movie' || raw === 'film') return 'movie';
  if (raw === 'series' || raw === 'tv' || raw === 'show' || raw === 'anime') return 'series';
  return null;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function cleanImdb(value: unknown): string | null {
  const id = String(value || '').trim();
  return IMDB.test(id) ? id : null;
}

// One content id (plus the type it was stored with, and the season/episode
// columns when the row has them) -> its parts, or null when it names nothing
// usable. Episode video ids (`tt123:1:2`, `torbox:series:42:1:2`) carry their
// numbers in the id itself.
function parseContentId(contentId: unknown, contentType?: unknown, season?: unknown, episode?: unknown): ParsedId | null {
  const id = String(contentId || '').trim();
  if (!id || id.length > 200) return null;
  const parts = id.split(':');
  let type = mediaType(contentType);
  let tmdb: number | null = null;
  let imdb: string | null = null;
  let other: string | null = null;
  let rest: string[] = [];
  const head = (parts[0] || '').toLowerCase();
  if (IMDB.test(parts[0] || '')) {
    imdb = parts[0] as string;
    rest = parts.slice(1);
  } else if (head === 'torbox' || head === 'tmdb') {
    // torbox:{type}:{id}[:s:e] / tmdb:{id} / tmdb:{type}:{id}[:s:e]
    const maybeType = mediaType(parts[1]);
    if (maybeType) {
      type = maybeType;
      tmdb = positiveInt(parts[2]);
      rest = parts.slice(3);
    } else {
      tmdb = positiveInt(parts[1]);
      rest = parts.slice(2);
    }
    if (!tmdb) return null;
  } else if (/^[a-z][a-z0-9_-]{1,15}$/.test(head) && parts[1]) {
    other = `${head}:${parts[1]}`;
    rest = parts.slice(2);
  } else {
    return null;
  }
  let s = nonNegativeInt(season);
  let e = positiveInt(episode);
  if (s === null && e === null && rest.length >= 2) {
    s = nonNegativeInt(rest[0]);
    e = positiveInt(rest[1]);
  } else if (s === null && e === null && rest.length === 1 && other) {
    // kitsu:{id}:{episode}
    e = positiveInt(rest[0]);
  }
  if (e !== null) type = 'series';
  if (!type) return null;
  return { type, tmdb, imdb, other, season: e !== null ? (s ?? 1) : null, episode: e };
}

function titleKey(type: MediaType, ns: 'tmdb' | 'imdb', id: number | string): string {
  return `${type}:${ns}:${id}`;
}

function episodeKey(tmdb: number, season: number, episode: number): string {
  return `series:tmdb:${tmdb}:s${season}e${episode}`;
}

// The title keys one parsed id names (never its episode).
function keysOf(parsed: Pick<ParsedId, 'type' | 'tmdb' | 'imdb' | 'other'>): string[] {
  const out: string[] = [];
  if (parsed.tmdb) out.push(titleKey(parsed.type, 'tmdb', parsed.tmdb));
  if (parsed.imdb) out.push(titleKey(parsed.type, 'imdb', parsed.imdb));
  if (parsed.other) out.push(`${parsed.type}:${parsed.other}`);
  return out;
}

// Every key a catalogue meta can be matched by: its id (library or
// discovery), its `tmdbId`, and any IMDb id it carries.
function metaKeys(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const type = mediaType(meta['type']);
  const parsed = parseContentId(meta['id'], meta['type']);
  const out = new Set<string>(parsed ? keysOf({ ...parsed, type: type || parsed.type }) : []);
  const t = type || parsed?.type;
  if (!t) return [...out];
  const tmdb = positiveInt(meta['tmdbId'] ?? meta['tmdb_id'] ?? meta['moviedb_id']);
  if (tmdb) out.add(titleKey(t, 'tmdb', tmdb));
  const imdb = cleanImdb(meta['imdbId'] ?? meta['imdb_id']);
  if (imdb) out.add(titleKey(t, 'imdb', imdb));
  return [...out];
}

export interface WatchHistoryIdsApi {
  parseContentId: typeof parseContentId;
  titleKey: typeof titleKey;
  episodeKey: typeof episodeKey;
  keysOf: typeof keysOf;
  metaKeys: typeof metaKeys;
  mediaType: typeof mediaType;
  cleanImdb: typeof cleanImdb;
}

module.exports = { parseContentId, titleKey, episodeKey, keysOf, metaKeys, mediaType, cleanImdb } satisfies WatchHistoryIdsApi;
