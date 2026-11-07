'use strict';
// Watch history reader (v6): one setup's watched set, caught-up shows,
// Continue Watching and Up Next, from the sources it has switched on.
//
// - Nuvio: the setup's saved Nuvio login, the selected profile (as the push
//   uses it). Finished items from `sync_pull_watched_items` (paged) plus
//   progress from `sync_pull_watch_progress` (complete at >= 90%, Nuvio's
//   own rule). The two delta cursors are the cheap "did anything change"
//   gate: unchanged cursors keep the last copy without a pull. Shows: one
//   TMDB TV detail each (shared, public) gives the last aired episode, for
//   "caught up" and the next episode.
// - Simkl: the completed and watching lists through the personal-rows
//   buckets (same caches and /sync/activities gate as the Simkl rows).
// - MDBList (off by default: the user's own daily allowance): read only when
//   /sync/last_activities changes; /sync/watched ids only, /sync/playback,
//   and the Up Next row's bucket.
// - AniList: the completed and watching lists (personal-rows cache, the
//   server-wide AniList budget).
//
// Everything is per setup: cache keys carry a fingerprint of the setup and
// its credentials (hashShort), nothing is shared but public TMDB details.
// A setup's state is rebuilt at most every REFRESH_MS, and only when a
// catalogue request asks for it (an active setup). Logs never carry a
// token, key or title.
import type { UserListContext, UserListRuntimeApi } from '../user-lists/runtime.ts';
import type { ListItem } from '../user-lists/metas.ts';
import type { HistorySource, WatchHistoryConfigApi } from './config.ts';
import type { MediaType, ParsedId, WatchHistoryIdsApi } from './ids.ts';
import type { BoundedMapApi } from '../runtime/bounded-map.ts';

const rt = require('../user-lists/runtime.ts') as UserListRuntimeApi;
const ids = require('./ids.ts') as WatchHistoryIdsApi;
const cfg = require('./config.ts') as WatchHistoryConfigApi;
const { boundedSet } = require('../runtime/bounded-map.ts') as BoundedMapApi;
const { hashShort } = require('../runtime/cache-fingerprint.ts') as { hashShort: (value: unknown) => string };

// Cache namespace. Bump when a stored shape changes.
const NS = 'whist:v1';
const REFRESH_MS = 10 * 60 * 1000;
const STATE_TTL_S = 24 * 60 * 60;
const NUVIO_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const NUVIO_STORE_TTL_S = 2 * 24 * 60 * 60;
const PROFILE_TTL_S = 24 * 60 * 60;
const TMDB_TTL_S = 12 * 60 * 60;
const MDB_FRESH_MS = 60 * 60 * 1000;
const MDB_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Completed at this share of the runtime (Nuvio's own threshold).
const COMPLETE_AT = 0.9;
// Below this a "started" film is a misclick, not something to continue.
const STARTED_AT = 0.02;
const NUVIO_PAGE = 900;
const NUVIO_MAX_PAGES = 6;
const PROGRESS_LIMIT = 300;
const SHOW_LOOKUPS = 150;
const ID_LOOKUPS = 300;
const ROW_CAP = 60;
const MDB_PAGE = 1000;
const MDB_MAX_PAGES = 5;
const STATE_MAX = 2000;

export interface HistoryItem {
  type: MediaType;
  tmdb: number | null;
  imdb: string | null;
  title: string;
  season?: number | null;
  episode?: number | null;
  // Share watched (0-1) for Continue Watching.
  pct?: number | null;
  at: number;
  poster?: string | null;
}

// What one source contributes.
export interface SourceSnapshot {
  watched: string[];
  caughtUp: string[];
  continue: HistoryItem[];
  upnext: HistoryItem[];
}

export interface HistoryState {
  v: 1;
  builtAt: number;
  // Changes whenever the watched / caught-up sets change.
  version: string;
  watched: string[];
  caughtUp: string[];
  continue: HistoryItem[];
  upnext: HistoryItem[];
  sources: HistorySource[];
}

export interface TvInfo { name: string; poster: string | null; seasons: { n: number; count: number }[]; last: { s: number; e: number } | null; imdb: string | null }
export interface MovieInfo { title: string; poster: string | null; imdb: string | null }

type Config = Record<string, unknown>;

export interface ReaderDeps {
  ctx?: Partial<UserListContext>;
  // Test seams. Production uses the setup's own Nuvio login, TMDB, the
  // personal-rows readers and the AniList id map.
  nuvioRpc?: (config: Config) => ((name: string, body?: Record<string, unknown>) => Promise<unknown>) | null;
  tvInfo?: (tmdbId: number) => Promise<TvInfo | null>;
  movieInfo?: (tmdbId: number) => Promise<MovieInfo | null>;
  imdbToTmdb?: (imdb: string, type: MediaType) => Promise<number | null>;
  tmdbToImdb?: (type: MediaType, tmdbIds: number[]) => Promise<Map<number, string | null>>;
  simklAuth?: (config: Config) => Promise<{ token: string; clientId: string } | null>;
  simklEntries?: (kind: string, status: string) => Promise<{ item: ListItem; at: string; next?: string | null }[]>;
  mdblistUpnext?: () => Promise<ListItem[]>;
  anilistItems?: (list: string, type: MediaType) => Promise<ListItem[]>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function setupUuid(config: Config): string {
  const scope = (config as { __configScope?: { type?: string; uuid?: string } }).__configScope;
  return scope && scope.type === 'config' && typeof scope.uuid === 'string' ? scope.uuid.toLowerCase() : '';
}

function epochMs(value: unknown): number {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── TMDB (public facts, shared) ───────────────────────────────────────
function tmdbKey(config: Config): string {
  try {
    const server = (require('../catalog/own-art.ts') as { liveArtKey: () => string }).liveArtKey();
    if (server) return server;
  } catch { /* no server key: the setup's own */ }
  return String(config['tmdbApiKey'] || '');
}

function tmdbRequest(key: string): { headers: Record<string, string>; params: Record<string, string> } {
  return key.startsWith('eyJ') ? { headers: { Authorization: `Bearer ${key}` }, params: {} } : { headers: {}, params: { api_key: key } };
}

function liveTvInfo(ctx: UserListContext, key: string): (tmdbId: number) => Promise<TvInfo | null> {
  return async (tmdbId) => {
    if (!key) return null;
    const cacheKey = `${NS}:tv:${tmdbId}`;
    const hit = await ctx.store.get(cacheKey).catch(() => null) as { value: TvInfo | null } | null;
    if (hit && typeof hit === 'object' && 'value' in hit) return hit.value;
    return rt.singleFlight(cacheKey, async () => {
      const auth = tmdbRequest(key);
      try {
        const res = await ctx.http.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, {
          headers: auth.headers, params: { ...auth.params, append_to_response: 'external_ids' }, timeout: 8000,
        });
        const data = asRecord(res?.data);
        const lastEp = asRecord(data['last_episode_to_air']);
        const value: TvInfo = {
          name: String(data['name'] || '').slice(0, 200),
          poster: typeof data['poster_path'] === 'string' ? data['poster_path'] as string : null,
          seasons: (Array.isArray(data['seasons']) ? data['seasons'] as unknown[] : []).map(asRecord)
            .map((row) => ({ n: Number(row['season_number']), count: Number(row['episode_count']) || 0 }))
            .filter((row) => Number.isInteger(row.n) && row.n > 0),
          last: Number.isInteger(Number(lastEp['season_number'])) && Number(lastEp['episode_number']) > 0
            ? { s: Number(lastEp['season_number']), e: Number(lastEp['episode_number']) } : null,
          imdb: ids.cleanImdb(asRecord(data['external_ids'])['imdb_id']),
        };
        await ctx.store.set(cacheKey, { value }, TMDB_TTL_S).catch(() => {});
        return value;
      } catch (err) {
        if (rt.statusOf(err) === 404) await ctx.store.set(cacheKey, { value: null }, TMDB_TTL_S).catch(() => {});
        return null;
      }
    });
  };
}

function liveMovieInfo(ctx: UserListContext, key: string): (tmdbId: number) => Promise<MovieInfo | null> {
  return async (tmdbId) => {
    if (!key) return null;
    const cacheKey = `${NS}:movie:${tmdbId}`;
    const hit = await ctx.store.get(cacheKey).catch(() => null) as { value: MovieInfo | null } | null;
    if (hit && typeof hit === 'object' && 'value' in hit) return hit.value;
    return rt.singleFlight(cacheKey, async () => {
      const auth = tmdbRequest(key);
      try {
        const res = await ctx.http.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, { headers: auth.headers, params: auth.params, timeout: 8000 });
        const data = asRecord(res?.data);
        const value: MovieInfo = {
          title: String(data['title'] || '').slice(0, 200),
          poster: typeof data['poster_path'] === 'string' ? data['poster_path'] as string : null,
          imdb: ids.cleanImdb(data['imdb_id']),
        };
        await ctx.store.set(cacheKey, { value }, TMDB_TTL_S).catch(() => {});
        return value;
      } catch {
        return null;
      }
    });
  };
}

// ── Next episode / caught up from TMDB's season sizes ─────────────────
function compareEp(a: { s: number; e: number }, b: { s: number; e: number }): number {
  return a.s !== b.s ? a.s - b.s : a.e - b.e;
}

// The episode after (s, e) that exists and has aired, or null.
function nextEpisode(info: TvInfo, s: number, e: number): { s: number; e: number } | null {
  if (!info.last) return null;
  const season = info.seasons.find((row) => row.n === s);
  let next: { s: number; e: number } | null = null;
  if (season && e < season.count) next = { s, e: e + 1 };
  else {
    const later = info.seasons.filter((row) => row.n > s && row.count > 0).sort((a, b) => a.n - b.n)[0];
    if (later) next = { s: later.n, e: 1 };
  }
  if (!next || compareEp(next, info.last) > 0) return null;
  return next;
}

function epCode(s: number | null | undefined, e: number | null | undefined): string {
  if (!e) return '';
  return `S${String(s ?? 1).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
}

// ── Nuvio ─────────────────────────────────────────────────────────────
export interface NuvioWatchedRow { id: string; type: string; title: string; season: number | null; episode: number | null; at: number }
export interface NuvioProgressRow { id: string; type: string; season: number | null; episode: number | null; position: number; duration: number; at: number }
export interface NuvioPull { watched: NuvioWatchedRow[]; progress: NuvioProgressRow[] }

function liveNuvioRpc(config: Config): ((name: string, body?: Record<string, unknown>) => Promise<unknown>) | null {
  const conn = asRecord(asRecord(config['push'])['nuvio']);
  const uuid = setupUuid(config);
  if (!uuid || typeof conn['nuvioToken'] !== 'string' || !conn['nuvioToken']) return null;
  const { createNuvioClient } = require('../nuvio/client.ts') as { createNuvioClient: (options: Record<string, unknown>) => { rpc: (name: string, body?: Record<string, unknown>) => Promise<unknown> } };
  const conns = require('../setup/connections.ts');
  const runtime = require('../setup/runtime.ts');
  const client = createNuvioClient({
    uuid,
    connection: conn,
    // A rotated Nuvio session is saved back, as every Nuvio call does.
    persist: async (next: Record<string, unknown>) => {
      const store = await runtime.getSetupStore();
      const current = store ? await store.resolveByUuid(uuid) : null;
      if (store && current) await store.save(uuid, { keys: conns.mergePushKeys(current.keys || {}, 'nuvio', next) });
    },
    reload: async () => {
      const store = await runtime.getSetupStore();
      return store ? conns.readPush(await store.resolveByUuid(uuid), 'nuvio') : null;
    },
  });
  return (name, body) => client.rpc(name, body);
}

// Who the Nuvio login is (not its rotating tokens), plus the profile.
function nuvioIdentity(config: Config): string {
  const conn = asRecord(asRecord(config['push'])['nuvio']);
  const user = asRecord(conn['nuvioUser']);
  return `${setupUuid(config)}:${String(user['id'] || user['email'] || '')}:${String(conn['nuvioSelectedProfile'] ?? '')}`;
}

async function nuvioProfileIndex(ctx: UserListContext, config: Config, rpc: (name: string, body?: Record<string, unknown>) => Promise<unknown>, fp: string): Promise<number> {
  return rt.cachedValue(ctx, `${NS}:nuvio-profile:${fp}`, `${NS}:nuvio-backoff:${fp}`, PROFILE_TTL_S, async () => {
    const data = await rpc('sync_pull_profiles');
    const list = (Array.isArray(data) ? data : asRecord(data)['profiles']) as unknown[] | undefined;
    const profiles = (Array.isArray(list) ? list : []).map(asRecord).map((row) => ({ ...row, profile_index: Math.trunc(Number(row['profile_index'])) }));
    const { resolveNuvioProfile } = require('../setup/push.ts') as { resolveNuvioProfile: (p: unknown[], s: unknown) => { ok: boolean; profile?: { profile_index: number }; error?: string } };
    const resolved = resolveNuvioProfile(profiles, asRecord(asRecord(config['push'])['nuvio'])['nuvioSelectedProfile']);
    if (!resolved.ok || !resolved.profile) throw new Error('Nuvio profile not found');
    return resolved.profile.profile_index;
  });
}

function nuvioRows(data: unknown): Record<string, unknown>[] {
  return (Array.isArray(data) ? data : []).map(asRecord);
}

async function pullNuvio(rpc: (name: string, body?: Record<string, unknown>) => Promise<unknown>, profile: number): Promise<NuvioPull> {
  const watched: NuvioWatchedRow[] = [];
  for (let page = 1; page <= NUVIO_MAX_PAGES; page++) {
    const rows = nuvioRows(await rpc('sync_pull_watched_items', { p_profile_id: profile, p_page: page, p_page_size: NUVIO_PAGE }));
    for (const row of rows) {
      const id = String(row['content_id'] || '');
      if (!id) continue;
      watched.push({
        id: id.slice(0, 200),
        type: String(row['content_type'] || ''),
        title: String(row['title'] || '').slice(0, 200),
        season: row['season'] === null || row['season'] === undefined ? null : Number(row['season']),
        episode: row['episode'] === null || row['episode'] === undefined ? null : Number(row['episode']),
        at: epochMs(row['watched_at']),
      });
    }
    if (rows.length < NUVIO_PAGE) break;
  }
  const progress = nuvioRows(await rpc('sync_pull_watch_progress', { p_profile_id: profile, p_limit: PROGRESS_LIMIT })).map((row) => ({
    id: String(row['content_id'] || '').slice(0, 200),
    type: String(row['content_type'] || ''),
    season: row['season'] === null || row['season'] === undefined ? null : Number(row['season']),
    episode: row['episode'] === null || row['episode'] === undefined ? null : Number(row['episode']),
    position: Number(row['position']) || 0,
    duration: Number(row['duration']) || 0,
    at: epochMs(row['last_watched']),
  })).filter((row) => row.id);
  return { watched, progress };
}

// The raw Nuvio history for one setup: pulled again only when a delta
// cursor moved (or after NUVIO_MAX_AGE_MS).
async function nuvioPullFor(ctx: UserListContext, config: Config, deps: ReaderDeps): Promise<NuvioPull | null> {
  const rpc = (deps.nuvioRpc || liveNuvioRpc)(config);
  if (!rpc) return null;
  const fp = hashShort(`nuvio:${nuvioIdentity(config)}`);
  const data = await rt.gatedBucket<NuvioPull>({
    ctx,
    key: `${NS}:nuvio:${fp}`,
    backoffKey: `${NS}:nuvio-backoff:${fp}`,
    label: 'watch-history nuvio',
    freshMs: REFRESH_MS,
    maxAgeMs: NUVIO_MAX_AGE_MS,
    storeTtlS: NUVIO_STORE_TTL_S,
    stamp: async () => {
      const profile = await nuvioProfileIndex(ctx, config, rpc, fp);
      const [watched, progress] = await Promise.all([
        rpc('sync_get_watched_items_delta_cursor', { p_profile_id: profile }),
        rpc('sync_get_watch_progress_delta_cursor', { p_profile_id: profile }),
      ]);
      return `${profile}:${Number(watched) || 0}:${Number(progress) || 0}`;
    },
    load: async () => pullNuvio(rpc, await nuvioProfileIndex(ctx, config, rpc, fp)),
  });
  return data || null;
}

export interface IdTools {
  tvInfo: (tmdbId: number) => Promise<TvInfo | null>;
  movieInfo: (tmdbId: number) => Promise<MovieInfo | null>;
  imdbToTmdb: (imdb: string, type: MediaType) => Promise<number | null>;
}

// Nuvio rows -> a snapshot. Pure apart from the id/TMDB tools.
async function nuvioSnapshot(pull: NuvioPull, tools: IdTools): Promise<SourceSnapshot> {
  let lookups = 0;
  const tmdbFor = async (parsed: ParsedId): Promise<number | null> => {
    if (parsed.tmdb) return parsed.tmdb;
    if (!parsed.imdb || lookups >= ID_LOOKUPS) return null;
    lookups += 1;
    return tools.imdbToTmdb(parsed.imdb, parsed.type).catch(() => null);
  };
  const watched = new Set<string>();
  const caughtUp = new Set<string>();
  // Show (by its first key) -> what we know.
  interface ShowAcc { parsed: ParsedId; title: string; eps: Map<string, number>; whole: boolean; lastAt: number; last: { s: number; e: number } | null }
  const shows = new Map<string, ShowAcc>();
  const continueItems: HistoryItem[] = [];
  const showOf = (parsed: ParsedId, title: string): ShowAcc | null => {
    const key = ids.keysOf(parsed)[0];
    if (!key) return null;
    let acc = shows.get(key);
    if (!acc) { acc = { parsed, title, eps: new Map(), whole: false, lastAt: 0, last: null }; shows.set(key, acc); }
    if (!acc.title && title) acc.title = title;
    return acc;
  };
  const markEpisode = (acc: ShowAcc, s: number, e: number, at: number) => {
    acc.eps.set(`${s}:${e}`, at);
    if (at >= acc.lastAt) { acc.lastAt = at; acc.last = { s, e }; }
  };
  for (const row of pull.watched) {
    const parsed = ids.parseContentId(row.id, row.type, row.season, row.episode);
    if (!parsed) continue;
    if (parsed.type === 'movie') {
      for (const key of ids.keysOf(parsed)) watched.add(key);
      const tmdb = await tmdbFor(parsed);
      if (tmdb) watched.add(ids.titleKey('movie', 'tmdb', tmdb));
      continue;
    }
    const acc = showOf({ ...parsed, season: null, episode: null }, row.title);
    if (!acc) continue;
    if (parsed.episode) markEpisode(acc, parsed.season ?? 1, parsed.episode, row.at);
    else acc.whole = true;
  }
  // Progress: complete counts as watched, anything else may continue.
  const progress = pull.progress.slice().sort((a, b) => b.at - a.at);
  const seenContinue = new Set<string>();
  for (const row of progress) {
    const parsed = ids.parseContentId(row.id, row.type, row.season, row.episode);
    if (!parsed || row.duration <= 0) continue;
    const pct = row.position / row.duration;
    if (pct >= COMPLETE_AT) {
      if (parsed.type === 'movie') {
        for (const key of ids.keysOf(parsed)) watched.add(key);
      } else if (parsed.episode) {
        const acc = showOf({ ...parsed, season: null, episode: null }, '');
        if (acc) markEpisode(acc, parsed.season ?? 1, parsed.episode, row.at);
      }
      continue;
    }
    if (pct < STARTED_AT) continue;
    const titleKey = ids.keysOf(parsed)[0];
    if (!titleKey || seenContinue.has(titleKey)) continue;
    seenContinue.add(titleKey);
    continueItems.push({
      type: parsed.type, tmdb: parsed.tmdb, imdb: parsed.imdb, title: '',
      season: parsed.episode ? parsed.season ?? 1 : null, episode: parsed.episode, pct: Math.round(pct * 100) / 100, at: row.at,
    });
  }
  // Shows: caught up and the next episode, newest first, bounded lookups.
  const upnext: HistoryItem[] = [];
  const ordered = [...shows.values()].sort((a, b) => b.lastAt - a.lastAt);
  let showLookups = 0;
  for (const acc of ordered) {
    const tmdb = await tmdbFor(acc.parsed);
    const keys = new Set(ids.keysOf(acc.parsed));
    if (tmdb) keys.add(ids.titleKey('series', 'tmdb', tmdb));
    if (acc.whole) { for (const key of keys) caughtUp.add(key); continue; }
    if (!tmdb || !acc.last || showLookups >= SHOW_LOOKUPS) continue;
    showLookups += 1;
    const info = await tools.tvInfo(tmdb).catch(() => null);
    if (!info || !info.last) continue;
    if (info.imdb) keys.add(ids.titleKey('series', 'imdb', info.imdb));
    if (acc.eps.has(`${info.last.s}:${info.last.e}`)) { for (const key of keys) caughtUp.add(key); continue; }
    let next = nextEpisode(info, acc.last.s, acc.last.e);
    // Skip ahead over episodes already watched (rewatching out of order).
    let guard = 0;
    while (next && acc.eps.has(`${next.s}:${next.e}`) && guard++ < 50) next = nextEpisode(info, next.s, next.e);
    if (next) {
      upnext.push({ type: 'series', tmdb, imdb: info.imdb || acc.parsed.imdb, title: acc.title || info.name, season: next.s, episode: next.e, at: acc.lastAt, poster: info.poster });
    }
  }
  // Continue Watching titles and posters (Nuvio progress rows have none).
  for (const item of continueItems.slice(0, ROW_CAP)) {
    const parsed: ParsedId = { type: item.type, tmdb: item.tmdb, imdb: item.imdb, other: null, season: null, episode: null };
    const tmdb = await tmdbFor(parsed);
    if (!tmdb) continue;
    item.tmdb = tmdb;
    if (item.type === 'series') {
      const info = await tools.tvInfo(tmdb).catch(() => null);
      if (info) { item.title = info.name; item.poster = info.poster; item.imdb = item.imdb || info.imdb; }
    } else {
      const info = await tools.movieInfo(tmdb).catch(() => null);
      if (info) { item.title = info.title; item.poster = info.poster; item.imdb = item.imdb || info.imdb; }
    }
  }
  return { watched: [...watched], caughtUp: [...caughtUp], continue: continueItems.filter((item) => item.tmdb || item.imdb), upnext };
}

// ── Simkl / MDBList / AniList ─────────────────────────────────────────
function listItemKeys(item: ListItem): string[] {
  const out: string[] = [];
  const tmdb = Number(item.tmdb) || 0;
  if (tmdb > 0) out.push(ids.titleKey(item.type, 'tmdb', tmdb));
  const imdb = ids.cleanImdb(item.imdb);
  if (imdb) out.push(ids.titleKey(item.type, 'imdb', imdb));
  return out;
}

function parseCode(value: unknown): { s: number; e: number } | null {
  const m = String(value || '').match(/S(\d{1,4})E(\d{1,5})/i);
  return m ? { s: Number(m[1]), e: Number(m[2]) } : null;
}

async function simklSnapshot(ctx: UserListContext, config: Config, deps: ReaderDeps): Promise<SourceSnapshot | null> {
  let entries = deps.simklEntries;
  if (!entries) {
    const auth = await (deps.simklAuth || (async (c: Config) => {
      const { simklAuthForConfig } = require('../setup/connections.ts') as { simklAuthForConfig: (c: Config) => Promise<{ token: string; clientId: string } | null> };
      return simklAuthForConfig(c);
    }))(config).catch(() => null);
    if (!auth) return null;
    const simkl = require('../user-lists/simkl.ts') as { simklEntries: (ctx: UserListContext, auth: unknown, kind: string, status: string) => Promise<{ item: ListItem; at: string; next?: string | null }[]> };
    entries = (kind, status) => simkl.simklEntries(ctx, auth, kind, status);
  }
  const [showsDone, animeDone, moviesDone, showsWatching, animeWatching] = await Promise.all([
    entries('shows', 'completed'), entries('anime', 'completed'), entries('movies', 'completed'),
    entries('shows', 'watching'), entries('anime', 'watching'),
  ]);
  const out: SourceSnapshot = { watched: [], caughtUp: [], continue: [], upnext: [] };
  for (const entry of [...showsDone, ...animeDone, ...moviesDone]) {
    (entry.item.type === 'movie' ? out.watched : out.caughtUp).push(...listItemKeys(entry.item));
  }
  for (const entry of [...showsWatching, ...animeWatching]) {
    if (entry.item.type !== 'series') continue;
    const at = epochMs(entry.at);
    const next = parseCode(entry.next);
    // Watching with nothing next to see: caught up with what has aired.
    if (!entry.next) out.caughtUp.push(...listItemKeys(entry.item));
    out.continue.push({ type: 'series', tmdb: Number(entry.item.tmdb) || null, imdb: ids.cleanImdb(entry.item.imdb), title: entry.item.title, at, poster: entry.item.poster ?? null });
    if (next) out.upnext.push({ type: 'series', tmdb: Number(entry.item.tmdb) || null, imdb: ids.cleanImdb(entry.item.imdb), title: entry.item.title, season: next.s, episode: next.e, at, poster: entry.item.poster ?? null });
  }
  return out;
}

async function mdblistSnapshot(ctx: UserListContext, config: Config, deps: ReaderDeps): Promise<SourceSnapshot | null> {
  const key = String(config['mdblistKey'] || '').trim();
  if (!key) return null;
  const mdblist = require('../user-lists/mdblist.ts') as {
    mdblistActivityStamp: (ctx: UserListContext, key: string) => () => Promise<string | null>;
    mdblistRowItems: (ctx: UserListContext, key: string, list: string, type: 'movie' | 'series') => Promise<ListItem[]>;
  };
  const fp = rt.credentialFp('mdblist', key);
  const API = 'https://api.mdblist.com';
  const data = await rt.gatedBucket<SourceSnapshot>({
    ctx,
    key: `${NS}:mdblist:${fp}`,
    // The same per-key wait as the MDBList rows: one allowance.
    backoffKey: rt.cacheKey('mdblist', 'backoff', fp),
    label: 'watch-history mdblist',
    freshMs: MDB_FRESH_MS,
    maxAgeMs: MDB_MAX_AGE_MS,
    storeTtlS: NUVIO_STORE_TTL_S,
    // Read only when /sync/last_activities changed (shared 5-min stamp).
    stamp: mdblist.mdblistActivityStamp(ctx, key),
    load: async () => {
      const out: SourceSnapshot = { watched: [], caughtUp: [], continue: [], upnext: [] };
      let cursor = '';
      for (let page = 0; page < MDB_MAX_PAGES; page++) {
        const res = await ctx.http.get(`${API}/sync/watched`, { params: { apikey: key, extended: 'ids_only', limit: MDB_PAGE, ...(cursor ? { cursor } : {}) }, timeout: 20000 });
        const body = asRecord(res?.data);
        for (const raw of Array.isArray(body['movies']) ? body['movies'] as unknown[] : []) {
          const tmdb = Number(asRecord(raw)['tmdb']);
          if (Number.isInteger(tmdb) && tmdb > 0) out.watched.push(ids.titleKey('movie', 'tmdb', tmdb));
        }
        for (const raw of Array.isArray(body['shows']) ? body['shows'] as unknown[] : []) {
          const row = asRecord(raw);
          const tmdb = Number(row['tmdb']);
          if (row['completed'] === true && Number.isInteger(tmdb) && tmdb > 0) out.caughtUp.push(ids.titleKey('series', 'tmdb', tmdb));
        }
        cursor = String(asRecord(body['pagination'])['next_cursor'] ?? '').trim();
        if (!cursor) break;
      }
      const playback = await ctx.http.get(`${API}/sync/playback`, { params: { apikey: key }, timeout: 15000 }).catch(() => null);
      for (const raw of Array.isArray(playback?.data) ? playback?.data as unknown[] : []) {
        const row = asRecord(raw);
        const isMovie = row['type'] === 'movie';
        const media = asRecord(isMovie ? row['movie'] : row['show']);
        const mids = asRecord(media['ids']);
        const episode = asRecord(row['episode']);
        const tmdb = Number(mids['tmdb']) || null;
        const imdb = ids.cleanImdb(mids['imdb']);
        if (!tmdb && !imdb) continue;
        out.continue.push({
          type: isMovie ? 'movie' : 'series', tmdb, imdb, title: String(media['title'] || '').slice(0, 200),
          season: isMovie ? null : Number(episode['season']) || null, episode: isMovie ? null : Number(episode['number'] ?? episode['episode']) || null,
          pct: Number.isFinite(Number(row['progress'])) ? Math.round(Number(row['progress'])) / 100 : null,
          at: epochMs(row['updated_at'] || row['paused_at']),
        });
      }
      return out;
    },
  });
  const upnextItems = await (deps.mdblistUpnext || (() => mdblist.mdblistRowItems(ctx, key, 'upnext', 'series')))().catch(() => [] as ListItem[]);
  const base = data || { watched: [], caughtUp: [], continue: [], upnext: [] };
  return {
    ...base,
    upnext: upnextItems.map((item, index) => {
      const code = parseCode(item.note);
      return { type: 'series' as const, tmdb: Number(item.tmdb) || null, imdb: ids.cleanImdb(item.imdb), title: item.title, season: code?.s ?? null, episode: code?.e ?? null, at: -index, poster: item.poster ?? null };
    }),
  };
}

async function anilistSnapshot(ctx: UserListContext, config: Config, deps: ReaderDeps): Promise<SourceSnapshot | null> {
  let items = deps.anilistItems;
  if (!items) {
    const conn = asRecord(asRecord(config['watchlist'])['anilist']);
    const token = typeof conn['access_token'] === 'string' ? conn['access_token'] as string : '';
    if (!token) return null;
    const anilist = require('../user-lists/anilist.ts') as { anilistRowItems: (ctx: UserListContext, auth: { token: string }, list: string, type: 'movie' | 'series') => Promise<ListItem[]> };
    items = (list, type) => anilist.anilistRowItems(ctx, { token }, list, type);
  }
  const [doneMovies, doneShows, current] = await Promise.all([items('completed', 'movie'), items('completed', 'series'), items('current', 'series')]);
  return {
    watched: doneMovies.flatMap(listItemKeys),
    caughtUp: doneShows.flatMap(listItemKeys),
    continue: current.map((item, index) => ({ type: 'series' as const, tmdb: Number(item.tmdb) || null, imdb: ids.cleanImdb(item.imdb), title: item.title, at: -index, poster: item.poster ?? null })),
    upnext: [],
  };
}

// ── Merge ──────────────────────────────────────────────────────────────
function dedupeItems(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  const out: HistoryItem[] = [];
  for (const item of items.slice().sort((a, b) => b.at - a.at)) {
    const keys = listItemKeys({ type: item.type, title: item.title, tmdb: item.tmdb, imdb: item.imdb });
    if (!keys.length || keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(item);
    if (out.length >= ROW_CAP) break;
  }
  return out;
}

function mergeSnapshots(parts: (SourceSnapshot | null)[], sources: HistorySource[], now: number): HistoryState {
  const watched = new Set<string>();
  const caughtUp = new Set<string>();
  const cont: HistoryItem[] = [];
  const upnext: HistoryItem[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const key of part.watched) watched.add(key);
    for (const key of part.caughtUp) caughtUp.add(key);
    cont.push(...part.continue);
    upnext.push(...part.upnext);
  }
  // A show you are caught up on has nothing to continue or watch next.
  const isCaughtUp = (item: HistoryItem) => item.type === 'series' && listItemKeys({ type: 'series', title: '', tmdb: item.tmdb, imdb: item.imdb }).some((key) => caughtUp.has(key));
  const isWatchedFilm = (item: HistoryItem) => item.type === 'movie' && listItemKeys({ type: 'movie', title: '', tmdb: item.tmdb, imdb: item.imdb }).some((key) => watched.has(key));
  const w = [...watched].sort();
  const c = [...caughtUp].sort();
  return {
    v: 1,
    builtAt: now,
    version: hashShort(JSON.stringify([w, c])).slice(0, 12),
    watched: w,
    caughtUp: c,
    continue: dedupeItems(cont.filter((item) => !isWatchedFilm(item) && !(item.type === 'series' && !item.episode && isCaughtUp(item)))),
    upnext: dedupeItems(upnext.filter((item) => !isCaughtUp(item))),
    sources,
  };
}

// ── Per-setup state ────────────────────────────────────────────────────
// Fingerprint of who is asking: the setup, its sources and its credentials
// (one-way), so a changed key or login never sees the old state.
function stateFingerprint(config: Config, sources: HistorySource[]): string {
  const watchlist = asRecord(config['watchlist']);
  const token = (provider: string) => String(asRecord(watchlist[provider])['refresh_token'] || asRecord(watchlist[provider])['access_token'] || '');
  return hashShort(JSON.stringify([
    setupUuid(config) || hashShort(JSON.stringify([token('simkl'), token('anilist'), String(config['mdblistKey'] || '')])),
    sources,
    sources.includes('nuvio') ? nuvioIdentity(config) : '',
    sources.includes('simkl') ? hashShort(`simkl:${token('simkl')}`) : '',
    sources.includes('mdblist') ? rt.credentialFp('mdblist', String(config['mdblistKey'] || '')) : '',
    sources.includes('anilist') ? hashShort(`anilist:${token('anilist')}`) : '',
  ]));
}

const memory = new Map<string, HistoryState>();

async function buildState(config: Config, sources: HistorySource[], ctx: UserListContext, deps: ReaderDeps): Promise<HistoryState> {
  const key = tmdbKey(config);
  const tools: IdTools = {
    tvInfo: deps.tvInfo || liveTvInfo(ctx, key),
    movieInfo: deps.movieInfo || liveMovieInfo(ctx, key),
    imdbToTmdb: deps.imdbToTmdb || (async (imdb) => {
      const found = await (require('../media/tmdb.ts') as { imdbToTmdbCached: (k: string, id: string) => Promise<{ tmdbId: number } | null> }).imdbToTmdbCached(key, imdb).catch(() => null);
      return found && Number(found.tmdbId) > 0 ? Number(found.tmdbId) : null;
    }),
  };
  const safe = async (label: string, work: () => Promise<SourceSnapshot | null>): Promise<SourceSnapshot | null> => {
    try { return await work(); } catch (err) {
      ctx.log(`[watch-history] ${label} failed: status=${rt.statusOf(err) || 'error'}`);
      return null;
    }
  };
  const parts = await Promise.all([
    sources.includes('nuvio') ? safe('nuvio', async () => {
      const pull = await nuvioPullFor(ctx, config, deps);
      return pull ? nuvioSnapshot(pull, tools) : null;
    }) : null,
    sources.includes('simkl') ? safe('simkl', () => simklSnapshot(ctx, config, deps)) : null,
    sources.includes('mdblist') ? safe('mdblist', () => mdblistSnapshot(ctx, config, deps)) : null,
    sources.includes('anilist') ? safe('anilist', () => anilistSnapshot(ctx, config, deps)) : null,
  ]);
  const state = mergeSnapshots(parts, sources, ctx.now());
  // Films known by one id only: add the other, so library rows (tmdb) and
  // discovery rows (IMDb) both match. Batched, cached by the TMDB helper.
  const toImdb = deps.tmdbToImdb || (async (type: MediaType, list: number[]) => (require('../media/tmdb.ts') as { getImdbIds: (k: string, t: string, l: number[]) => Promise<Map<number, string | null>> }).getImdbIds(key, type === 'movie' ? 'movie' : 'tv', list));
  for (const [type, set] of [['movie', state.watched], ['series', state.caughtUp]] as const) {
    const have = new Set(set);
    const lonely = set.filter((k) => k.startsWith(`${type}:tmdb:`)).map((k) => Number(k.split(':')[2])).slice(0, ID_LOOKUPS);
    if (!lonely.length || !key) continue;
    const found = await toImdb(type, lonely).catch(() => new Map<number, string | null>());
    for (const [tmdb, imdb] of found) {
      const clean = ids.cleanImdb(imdb);
      if (clean && have.has(ids.titleKey(type, 'tmdb', tmdb))) have.add(ids.titleKey(type, 'imdb', clean));
    }
    set.splice(0, set.length, ...[...have].sort());
  }
  return state;
}

// The setup's history for one request. Serves the last state at once and
// rebuilds it in the background when older than REFRESH_MS; with nothing
// built yet it waits up to `waitMs` (else answers null and keeps building).
async function historyFor(config: Config, options: { waitMs?: number } = {}, deps: ReaderDeps = {}): Promise<HistoryState | null> {
  const effective = cfg.effectiveWatchHistory(config);
  if (!effective.read.length) return null;
  const ctx = rt.withContext(deps.ctx);
  const fp = stateFingerprint(config, effective.read);
  const storeKey = `${NS}:state:${fp}`;
  let state: HistoryState | null = memory.get(fp) || null;
  if (!state) {
    const stored = await ctx.store.get(storeKey).catch(() => null) as HistoryState | null;
    if (stored && stored.v === 1 && Array.isArray(stored.watched)) {
      state = stored;
      boundedSet(memory, fp, stored, STATE_MAX);
    }
  }
  const now = ctx.now();
  if (state && now - state.builtAt < REFRESH_MS) return state;
  const build = rt.singleFlight(`${NS}:build:${fp}`, async () => {
    const next = await buildState(config, effective.read, ctx, deps);
    boundedSet(memory, fp, next, STATE_MAX);
    await ctx.store.set(storeKey, next, STATE_TTL_S).catch(() => {});
    return next;
  });
  if (state) { build.catch(() => {}); return state; }
  const waitMs = Math.max(0, options.waitMs ?? 2000);
  return Promise.race([
    build.catch(() => null),
    new Promise<null>((resolve) => { const timer = setTimeout(() => resolve(null), waitMs); (timer as { unref?: () => void }).unref?.(); }),
  ]);
}

// Test seam.
function resetReader(): void {
  memory.clear();
}

// ── Rows ───────────────────────────────────────────────────────────────
// Continue Watching / Up Next as list items (tt ids through itemsToMetas).
function historyRowItems(state: HistoryState | null, list: string, type: MediaType): ListItem[] {
  if (!state) return [];
  const source = list === 'continue' ? state.continue : list === 'upnext' ? state.upnext : [];
  return source.filter((item) => item.type === type).map((item) => {
    const code = epCode(item.season, item.episode);
    const pct = typeof item.pct === 'number' && item.pct > 0 ? `${Math.round(item.pct * 100)}%` : '';
    const note = list === 'upnext'
      ? (code ? `Next: ${code}` : '')
      : [code, pct].filter(Boolean).join(' · ');
    return { type: item.type, title: item.title || '', imdb: item.imdb, tmdb: item.tmdb, poster: item.poster ?? null, ...(note ? { note } : {}) };
  });
}

// ── Hide watched ───────────────────────────────────────────────────────
// Watched films and caught-up shows out of one page of metas. Runs per
// request on whatever the (shared) catalogue cache returned: per-user data
// never goes into a shared cache.
function filterWatched(metas: unknown[], state: HistoryState | null): unknown[] {
  if (!state || !Array.isArray(metas) || (!state.watched.length && !state.caughtUp.length)) return metas;
  const watched = new Set(state.watched);
  const caughtUp = new Set(state.caughtUp);
  return metas.filter((raw) => {
    const meta = asRecord(raw);
    const type = ids.mediaType(meta['type']);
    const keys = ids.metaKeys(meta);
    if (type === 'movie') return !keys.some((key) => watched.has(key));
    if (type === 'series') return !keys.some((key) => caughtUp.has(key));
    return true;
  });
}

export interface WatchHistoryReaderApi {
  NS: string;
  REFRESH_MS: number;
  COMPLETE_AT: number;
  historyFor: typeof historyFor;
  buildState: typeof buildState;
  nuvioSnapshot: typeof nuvioSnapshot;
  mergeSnapshots: typeof mergeSnapshots;
  nextEpisode: typeof nextEpisode;
  historyRowItems: typeof historyRowItems;
  filterWatched: typeof filterWatched;
  stateFingerprint: typeof stateFingerprint;
  resetReader: typeof resetReader;
  setupUuid: typeof setupUuid;
  liveNuvioRpc: typeof liveNuvioRpc;
  nuvioIdentity: typeof nuvioIdentity;
  epochMs: typeof epochMs;
}

module.exports = {
  NS, REFRESH_MS, COMPLETE_AT, historyFor, buildState, nuvioSnapshot, mergeSnapshots, nextEpisode, historyRowItems, filterWatched,
  stateFingerprint, resetReader, setupUuid, liveNuvioRpc, nuvioIdentity, epochMs,
} satisfies WatchHistoryReaderApi;
