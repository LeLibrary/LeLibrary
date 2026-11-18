'use strict';
// Per-setup favourites (v6.1): the short personal list of titles a person
// keeps, stored beside their setup row.
//
// Written from the setup page with the edit token (a password-gated setup
// needs it), or from the Releases page through a paired, scoped cookie (see
// setup/favourites-pairing.ts). Read by the library engine for the personal
// rows (`lelibrary-user-favourites-movie` / `-series`), which is what the
// Hub's Favourites folder points at.
//
// A favourite is only a TMDB id and a kind: no titles, no names, nothing about
// the person's other data. The catalogue is built from their own library rows,
// so a favourite whose file is gone simply does not appear.
//
// Not the same as a watchlist: only titles the person actually holds can show
// up, because the rows come from their library.

import type { PoolLike } from './config-store.ts';

export type FavouriteType = 'movie' | 'series';

export interface Favourite {
  mediaType: FavouriteType;
  tmdbId: number;
  addedAt: string;
}

export interface FavouriteSet {
  movie: Set<number>;
  series: Set<number>;
  // Changes whenever the list changes, for the catalogue cache key:
  // "<count>:<newest added at, unix seconds>".
  version: string;
}

// A person can keep a few hundred; the Hub folder is a shortlist, not a
// library. Refusing beyond this keeps the table and the row page small.
const MAX_FAVOURITES = 300;

// TMDB ids are positive 32-bit integers.
const MAX_TMDB_ID = 2147483647;

function normaliseType(value: unknown): FavouriteType | null {
  return value === 'movie' || value === 'series' ? value : null;
}

function normaliseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= MAX_TMDB_ID ? id : null;
}

function uuidParam(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function toFavourite(row: Record<string, unknown>): Favourite | null {
  const mediaType = normaliseType(row['media_type']);
  const tmdbId = normaliseId(row['tmdb_id']);
  if (!mediaType || tmdbId === null) return null;
  const addedAt = row['added_at'] instanceof Date
    ? row['added_at'].toISOString()
    : String(row['added_at'] || '');
  return { mediaType, tmdbId, addedAt };
}

export interface FavouritesApi {
  MAX_FAVOURITES: number;
  list: (pool: PoolLike, uuid: unknown) => Promise<Favourite[]>;
  count: (pool: PoolLike, uuid: unknown) => Promise<number>;
  add: (pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown) => Promise<'added' | 'exists' | 'full' | 'invalid'>;
  remove: (pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown) => Promise<boolean>;
  clear: (pool: PoolLike, uuid: unknown) => Promise<number>;
  set: (pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown, wanted: boolean) => Promise<'added' | 'removed' | 'unchanged' | 'full' | 'invalid'>;
  catalogIds: (pool: PoolLike, uuid: unknown, mediaType: FavouriteType) => Promise<{ ids: Set<number>; version: string }>;
  setForCatalog: (pool: PoolLike, uuid: unknown) => Promise<FavouriteSet>;
}

// Newest first: the list reads like a shelf of recent picks.
async function list(pool: PoolLike, uuid: unknown): Promise<Favourite[]> {
  const id = uuidParam(uuid);
  if (!id) return [];
  const { rows } = await pool.query(
    `SELECT media_type, tmdb_id, added_at
       FROM setup_favourites
      WHERE uuid = $1
      ORDER BY added_at DESC, tmdb_id DESC`,
    [id]
  );
  return (rows as Record<string, unknown>[]).map(toFavourite).filter((entry): entry is Favourite => entry !== null);
}

async function count(pool: PoolLike, uuid: unknown): Promise<number> {
  const id = uuidParam(uuid);
  if (!id) return 0;
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM setup_favourites WHERE uuid = $1', [id]);
  return Number((rows as Record<string, unknown>[])[0]?.['n']) || 0;
}

// Adding is idempotent: starring twice keeps one row and its original time.
async function add(pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown): Promise<'added' | 'exists' | 'full' | 'invalid'> {
  const id = uuidParam(uuid);
  const type = normaliseType(mediaType);
  const tmdb = normaliseId(tmdbId);
  if (!id || !type || tmdb === null) return 'invalid';
  const { rows } = await pool.query(
    `INSERT INTO setup_favourites (uuid, media_type, tmdb_id)
     SELECT $1, $2, $3
      WHERE (SELECT count(*) FROM setup_favourites WHERE uuid = $1) < $4
     ON CONFLICT DO NOTHING
     RETURNING media_type`,
    [id, type, tmdb, MAX_FAVOURITES]
  );
  if ((rows as unknown[]).length) return 'added';
  // Nothing inserted: either it was already there, or the list is full.
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM setup_favourites WHERE uuid = $1 AND media_type = $2 AND tmdb_id = $3',
    [id, type, tmdb]
  );
  return (existing as unknown[]).length ? 'exists' : 'full';
}

async function remove(pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown): Promise<boolean> {
  const id = uuidParam(uuid);
  const type = normaliseType(mediaType);
  const tmdb = normaliseId(tmdbId);
  if (!id || !type || tmdb === null) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM setup_favourites WHERE uuid = $1 AND media_type = $2 AND tmdb_id = $3',
    [id, type, tmdb]
  );
  return Number(rowCount) > 0;
}

// "Clear favourites" on the setup page: one row, no questions.
async function clear(pool: PoolLike, uuid: unknown): Promise<number> {
  const id = uuidParam(uuid);
  if (!id) return 0;
  const { rowCount } = await pool.query('DELETE FROM setup_favourites WHERE uuid = $1', [id]);
  return Number(rowCount) || 0;
}

// One call for the paired cookie's star: add or remove, never both.
async function set(pool: PoolLike, uuid: unknown, mediaType: unknown, tmdbId: unknown, wanted: boolean): Promise<'added' | 'removed' | 'unchanged' | 'full' | 'invalid'> {
  if (!wanted) return (await remove(pool, uuid, mediaType, tmdbId)) ? 'removed' : 'unchanged';
  const result = await add(pool, uuid, mediaType, tmdbId);
  return result === 'exists' ? 'unchanged' : result;
}

const EMPTY_VERSION = '0:0';

// The catalogue needs the ids and a version for its cache key in one read.
async function setForCatalog(pool: PoolLike, uuid: unknown): Promise<FavouriteSet> {
  const id = uuidParam(uuid);
  const set: FavouriteSet = { movie: new Set(), series: new Set(), version: EMPTY_VERSION };
  if (!id) return set;
  const { rows } = await pool.query(
    `SELECT media_type, tmdb_id,
            coalesce(extract(epoch FROM max(added_at) OVER ())::bigint, 0) AS newest,
            count(*) OVER ()::int AS total
       FROM setup_favourites
      WHERE uuid = $1
      ORDER BY added_at DESC`,
    [id]
  );
  const list = rows as Record<string, unknown>[];
  if (!list.length) return set;
  for (const row of list) {
    const type = normaliseType(row['media_type']);
    const tmdbId = normaliseId(row['tmdb_id']);
    if (!type || tmdbId === null) continue;
    set[type === 'movie' ? 'movie' : 'series'].add(tmdbId);
  }
  set.version = `${Number(list[0]?.['total']) || list.length}:${Number(list[0]?.['newest']) || 0}`;
  return set;
}

// One kind only (the two personal rows are served separately).
async function catalogIds(pool: PoolLike, uuid: unknown, mediaType: FavouriteType): Promise<{ ids: Set<number>; version: string }> {
  const all = await setForCatalog(pool, uuid);
  return { ids: mediaType === 'movie' ? all.movie : all.series, version: all.version };
}

module.exports = {
  MAX_FAVOURITES, list, count, add, remove, clear, set, catalogIds, setForCatalog,
} satisfies FavouritesApi;
