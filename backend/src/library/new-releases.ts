'use strict';
// The Hub's New Releases folder: My Movies / My Shows narrowed to titles
// released recently, newest first (`{prefix}-movies-new`,
// `{prefix}-series-new`).
//
//   films  TMDB digital release (the first "Digital" window, any region) in
//          the last 12 months, so a film that goes digital today lands at the
//          top even if its cinema run was months ago; `release_date` is the
//          fallback when TMDB has no digital date
//   shows  latest aired episode (TMDB last_episode_to_air, else
//          last_air_date) in the last 12 months, so a returning show with a
//          new season counts. TV has no digital release dates.
//
// The dates come from the same background TMDB read as "Your genres"
// (library/genres.ts, table lib_tmdb_genres): a fact about the title, shared
// by every library. A title without a date (not matched, not read yet, TMDB
// has none) is left out: never guessed. A date in the future is not out yet.

const store = require('./store.ts');

type Kind = 'movies' | 'series';

const WINDOW_MONTHS = 12;

// YYYY-MM-DD in UTC (TMDB dates carry no time zone).
function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The window as inclusive YYYY-MM-DD bounds: today and the same day a year
// ago (29 February falls back to 1 March).
function releaseWindow(now: Date = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - WINDOW_MONTHS, now.getUTCDate()));
  return { from: day(from), to: day(now) };
}

// The column the window and the order both read, so a row can never be
// filtered by one date and sorted by another.
function releaseDayColumn(kind: Kind): string {
  return kind === 'movies' ? 'coalesce(digital_release_date, release_date)' : 'last_air_date';
}

// The date a title counts by, from its stored facts.
function releaseDateFor(
  kind: Kind,
  facts: { release_date?: unknown; digital_release_date?: unknown; last_air_date?: unknown } | null | undefined
): string | null {
  const value = kind === 'movies' ? facts?.digital_release_date || facts?.release_date : facts?.last_air_date;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return day(value);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function isNewRelease(kind: Kind, facts: { release_date?: unknown; digital_release_date?: unknown; last_air_date?: unknown } | null | undefined, now: Date = new Date()): boolean {
  const date = releaseDateFor(kind, facts);
  if (!date) return false;
  const { from, to } = releaseWindow(now);
  return date >= from && date <= to;
}

// TMDB id -> date (YYYY-MM-DD) for every title of one kind released in the
// window. Shared by every library (the facts are), cached briefly and keyed on
// the fill's version, so a page cached during the first fill is rebuilt.
const cacheByKey = new Map<string, { at: number; dates: Map<number, string> }>();
const TTL_MS = 5 * 60 * 1000;

async function recentReleaseDates(kind: Kind, now: Date = new Date()): Promise<Map<number, string>> {
  const { from, to } = releaseWindow(now);
  const version = require('./genres.ts').genreVersion();
  const key = `${kind}:${from}:${to}:${version}`;
  const hit = cacheByKey.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.dates;
  const pool = await store.ensure();
  const column = releaseDayColumn(kind);
  const { rows } = await pool.query(
    `SELECT tmdb_id, to_char(${column}, 'YYYY-MM-DD') AS day
       FROM lib_tmdb_genres
      WHERE media_type = $1 AND ${column} BETWEEN $2::date AND $3::date`,
    [kind === 'movies' ? 'movie' : 'tv', from, to]
  );
  const dates = new Map<number, string>();
  for (const row of rows as Record<string, unknown>[]) {
    const id = Number(row['tmdb_id']);
    if (Number.isInteger(id) && typeof row['day'] === 'string') dates.set(id, row['day']);
  }
  // One entry per kind: an older day or version is never asked again.
  for (const old of cacheByKey.keys()) if (old.startsWith(`${kind}:`)) cacheByKey.delete(old);
  cacheByKey.set(key, { at: Date.now(), dates });
  return dates;
}

// The part of a catalogue cache key that changes when the answer can: the
// window moves daily and the fill adds dates.
function newReleasesKey(now: Date = new Date()): string {
  return `${releaseWindow(now).to}@${require('./genres.ts').genreVersion()}`;
}

export interface NewReleasesApi {
  WINDOW_MONTHS: number;
  releaseWindow: typeof releaseWindow;
  releaseDayColumn: typeof releaseDayColumn;
  releaseDateFor: typeof releaseDateFor;
  isNewRelease: typeof isNewRelease;
  recentReleaseDates: typeof recentReleaseDates;
  newReleasesKey: typeof newReleasesKey;
}

module.exports = { WINDOW_MONTHS, releaseWindow, releaseDayColumn, releaseDateFor, isNewRelease, recentReleaseDates, newReleasesKey } satisfies NewReleasesApi;
