'use strict';
// Copy Nuvio's finished history to Simkl, MDBList and AniList (v6, opt-in
// per service on the Watch history card). Never live scrobbling: Nuvio
// already scrobbles to Simkl/MDBList/Trakt when you sign in inside the app.
//
// - Runs about every SYNC_EVERY_MS per setup, and only for setups in use (a
//   catalogue request schedules the next run; nothing polls idle setups).
// - Reads Nuvio's watched-items delta (`sync_pull_watched_items_delta`) from
//   a per-service high-water mark (the event id), plus a short list of what
//   was already sent, so nothing is ever sent twice. Switching a service on
//   (or changing its account) copies the last 12 months of finished history
//   once; older plays are skipped but still move the mark, so a years-old
//   library is never dumped.
// - Writes in batches with the real watched_at: Simkl V2 `POST /sync/history`
//   (only V2 connections with media:write), MDBList `POST /sync/watched`
//   (MDBList merges plays within 12 h; a few requests per run, the person's
//   own allowance), AniList `SaveMediaListEntry` through a server-wide
//   bucket (AniList allows ~30/min per server IP, shared with the AniList
//   rows), mapped with the Fribb anime map; titles that do not map to
//   exactly one AniList entry are skipped, never guessed.
// - A 429 or failure leaves the mark where it was and waits (Retry-After).
// The marks are not secret (event ids and title keys): plain cache entries.
import type { UserListContext, UserListRuntimeApi } from '../user-lists/runtime.ts';
import type { SyncTarget, WatchHistoryConfigApi } from './config.ts';
import type { MediaType, WatchHistoryIdsApi } from './ids.ts';

const rt = require('../user-lists/runtime.ts') as UserListRuntimeApi;
const cfg = require('./config.ts') as WatchHistoryConfigApi;
const ids = require('./ids.ts') as WatchHistoryIdsApi;
const { hashShort } = require('../runtime/cache-fingerprint.ts') as { hashShort: (value: unknown) => string };
const { boundedSet } = require('../runtime/bounded-map.ts') as { boundedSet: <K, V>(map: Map<K, V>, key: K, value: V, max: number, stale?: (value: V) => boolean) => void };

const JOB_KIND = 'watch-history-sync';
const NS = 'whist:v1';
const SYNC_EVERY_MS = 30 * 60 * 1000;
const MARK_TTL_S = 90 * 24 * 60 * 60;
const SENT_MAX = 2000;
const DELTA_PAGE = 500;
const DELTA_MAX_PAGES = 4;
const SIMKL_BATCH = 100;
const MDBLIST_BATCH = 100;
const MDBLIST_MAX_REQUESTS = 3;
// How far back a service's first copy reaches (finished plays only).
const BACKFILL_DAYS = 365;
// Server-wide AniList writes per minute (the AniList rows keep their own
// budget; the shared per-call budget in user-lists/anilist.ts caps both).
const ANILIST_SYNC_PER_MIN = 8;
const NOTE_GAP_MS = 60 * 1000;

export interface SyncItem {
  eventId: number;
  type: MediaType;
  tmdb: number | null;
  imdb: string | null;
  season: number | null;
  episode: number | null;
  watchedAt: string;
  // Title (or episode) key + watched_at: the "already sent" identity.
  key: string;
}

export interface SyncMark {
  cursor: number;
  fp: string;
  sent: string[];
  // AniList: the progress already written per media id.
  progress?: Record<string, number>;
  waitUntil?: number;
  at: number;
}

type Config = Record<string, unknown>;
type Rpc = (name: string, body?: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function markKey(uuid: string, target: SyncTarget): string {
  return `${NS}:sync:${uuid}:${target}`;
}

function lastRunKey(uuid: string): string {
  return `${NS}:sync-run:${uuid}`;
}

// The account a mark belongs to (one-way): a new login starts fresh.
function targetFp(config: Config, target: SyncTarget): string {
  if (target === 'mdblist') return rt.credentialFp('mdblist', String(config['mdblistKey'] || ''));
  const conn = asRecord(asRecord(config['watchlist'])[target]);
  return hashShort(`${target}:${String(conn['refresh_token'] || conn['access_token'] || '')}`);
}

// One delta event -> a sync item, or null (removal, or nothing to map).
function itemFromEvent(raw: unknown): SyncItem | null {
  const event = asRecord(raw);
  const eventId = Number(event['event_id']);
  if (!Number.isFinite(eventId)) return null;
  if (String(event['operation'] || '').toLowerCase() !== 'upsert') return null;
  const parsed = ids.parseContentId(event['content_id'], event['content_type'], event['season'], event['episode']);
  if (!parsed || (!parsed.tmdb && !parsed.imdb)) return null;
  if (parsed.type === 'series' && !parsed.episode) return null;
  const at = Number(event['watched_at']);
  const watchedAt = new Date(Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = ids.keysOf(parsed)[0] as string;
  const key = `${parsed.type === 'series' ? `${title}:s${parsed.season}e${parsed.episode}` : title}@${watchedAt}`;
  return { eventId, type: parsed.type, tmdb: parsed.tmdb, imdb: parsed.imdb, season: parsed.season, episode: parsed.episode, watchedAt, key };
}

function idsOf(item: SyncItem): Record<string, unknown> {
  return { ...(item.tmdb ? { tmdb: item.tmdb } : {}), ...(item.imdb ? { imdb: item.imdb } : {}) };
}

// Simkl and MDBList take the same body: movies with ids + watched_at, shows
// with seasons and episodes, each episode with its own watched_at.
function historyBody(items: SyncItem[]): { movies: Record<string, unknown>[]; shows: Record<string, unknown>[] } {
  const movies = items.filter((item) => item.type === 'movie').map((item) => ({ ids: idsOf(item), watched_at: item.watchedAt }));
  const shows = new Map<string, { ids: Record<string, unknown>; seasons: Map<number, { number: number; watched_at: string }[]> }>();
  for (const item of items) {
    if (item.type !== 'series' || !item.episode) continue;
    const key = item.tmdb ? `t${item.tmdb}` : `i${item.imdb}`;
    let show = shows.get(key);
    if (!show) { show = { ids: idsOf(item), seasons: new Map() }; shows.set(key, show); }
    const season = item.season ?? 1;
    const list = show.seasons.get(season) || [];
    list.push({ number: item.episode, watched_at: item.watchedAt });
    show.seasons.set(season, list);
  }
  return {
    movies,
    shows: [...shows.values()].map((show) => ({
      ids: show.ids,
      seasons: [...show.seasons.entries()].sort((a, b) => a[0] - b[0]).map(([number, episodes]) => ({ number, episodes })),
    })),
  };
}

// ── AniList ────────────────────────────────────────────────────────────
// Server-wide write bucket (sliding minute).
const anilistSent: number[] = [];
function takeAnilistSlot(now: number): boolean {
  while (anilistSent.length && now - (anilistSent[0] as number) >= 60_000) anilistSent.shift();
  if (anilistSent.length >= ANILIST_SYNC_PER_MIN) return false;
  anilistSent.push(now);
  return true;
}

type Mapped = { imdb?: string; tv?: number; movie?: number };
const reverseCache = new WeakMap<object, Map<string, number[]>>();

// The Fribb map turned around: `movie:{tmdb}`, `tv:{tmdb}`, `imdb:{tt}` ->
// AniList ids.
function reverseMap(map: Record<string, Mapped>): Map<string, number[]> {
  const hit = reverseCache.get(map);
  if (hit) return hit;
  const out = new Map<string, number[]>();
  const add = (key: string, id: number) => { const list = out.get(key) || []; list.push(id); out.set(key, list); };
  for (const [anilistId, mapped] of Object.entries(map || {})) {
    const id = Number(anilistId);
    if (!Number.isInteger(id) || id <= 0 || !mapped) continue;
    if (mapped.movie) add(`movie:${mapped.movie}`, id);
    if (mapped.tv) add(`tv:${mapped.tv}`, id);
    if (mapped.imdb) add(`imdb:${mapped.imdb}`, id);
  }
  reverseCache.set(map, out);
  return out;
}

// Exactly one AniList entry for this title, or null. Shows only map for
// season 1 (AniList splits later seasons into their own entries, which the
// map cannot tell apart).
function anilistMediaId(item: SyncItem, map: Record<string, Mapped>): number | null {
  const reverse = reverseMap(map);
  const found = new Set<number>();
  if (item.tmdb) for (const id of reverse.get(`${item.type === 'movie' ? 'movie' : 'tv'}:${item.tmdb}`) || []) found.add(id);
  if (!found.size && item.imdb) for (const id of reverse.get(`imdb:${item.imdb}`) || []) found.add(id);
  if (found.size !== 1) return null;
  if (item.type === 'series' && (item.season ?? 1) !== 1) return null;
  return [...found][0] as number;
}

const SAVE_ENTRY = 'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress) { id } }';

// ── Writers ────────────────────────────────────────────────────────────
// Each answers how far it got: the event id of the last item handled (sent,
// or skipped as unmappable). Throws on an upstream failure.
export interface SyncDeps {
  ctx?: Partial<UserListContext>;
  openConfig?: (uuid: string) => Promise<Config | null>;
  nuvioRpc?: (config: Config) => Rpc | null;
  simklAuth?: (config: Config) => Promise<{ token: string; clientId: string; kind: string; write: boolean } | null>;
  idMap?: () => Promise<Record<string, Mapped>>;
  jobs?: { scheduleJob: (input: Record<string, unknown>) => Promise<unknown>; jobState: (kind: string, id: string) => unknown };
}

function appVersion(): string {
  try { return (require('../../../package.json') as { version: string }).version; } catch { return '0'; }
}

function appParams(clientId: string): Record<string, string> {
  return { client_id: clientId, 'app-name': 'lelibrary', 'app-version': appVersion() };
}

async function writeSimkl(ctx: UserListContext, config: Config, items: SyncItem[], deps: SyncDeps): Promise<number | null> {
  const resolve = deps.simklAuth || (async (c: Config) => {
    const { simklAuthForConfig } = require('../setup/connections.ts') as { simklAuthForConfig: (c: Config) => Promise<{ token: string; clientId: string; kind: string; write: boolean } | null> };
    return simklAuthForConfig(c);
  });
  const auth = await resolve(config);
  // Only V2 grants with media:write; a V1 connection reconnects first.
  if (!auth || auth.kind !== 'v2' || !auth.write) return null;
  const batch = items.slice(0, SIMKL_BATCH);
  if (!batch.length) return -1;
  await ctx.http.post('https://api.simkl.com/sync/history', historyBody(batch), {
    params: appParams(auth.clientId),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}`, 'User-Agent': `LeLibrary/${appVersion()}` },
    timeout: 20000,
  });
  return (batch[batch.length - 1] as SyncItem).eventId;
}

async function writeMdblist(ctx: UserListContext, config: Config, items: SyncItem[]): Promise<number | null> {
  const key = String(config['mdblistKey'] || '').trim();
  if (!key) return null;
  let done = -1;
  for (let request = 0; request < MDBLIST_MAX_REQUESTS; request++) {
    const batch = items.slice(request * MDBLIST_BATCH, (request + 1) * MDBLIST_BATCH);
    if (!batch.length) break;
    await ctx.http.post('https://api.mdblist.com/sync/watched', historyBody(batch), { params: { apikey: key }, headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    done = (batch[batch.length - 1] as SyncItem).eventId;
  }
  return done;
}

async function writeAnilist(ctx: UserListContext, config: Config, items: SyncItem[], mark: SyncMark, deps: SyncDeps): Promise<number | null> {
  const conn = asRecord(asRecord(config['watchlist'])['anilist']);
  const token = typeof conn['access_token'] === 'string' ? conn['access_token'] as string : '';
  if (!token) return null;
  const map = await (deps.idMap || (require('../catalog/anilist-season.ts') as { idMap: () => Promise<Record<string, Mapped>> }).idMap)().catch(() => ({}));
  const anilist = require('../user-lists/anilist.ts') as { anilistGraphql: (ctx: UserListContext, q: string, v: Record<string, unknown>, t: string) => Promise<unknown> };
  const progress = mark.progress || (mark.progress = {});
  let done = -1;
  for (const item of items) {
    const mediaId = anilistMediaId(item, map as Record<string, Mapped>);
    const vars = !mediaId ? null
      : item.type === 'movie' ? { mediaId, status: 'COMPLETED' }
        : (item.episode || 0) > (progress[String(mediaId)] || 0) ? { mediaId, status: 'CURRENT', progress: item.episode } : null;
    if (vars) {
      if (!takeAnilistSlot(ctx.now())) break;
      await anilist.anilistGraphql(ctx, SAVE_ENTRY, vars, token);
      if (item.type === 'series') progress[String(mediaId)] = item.episode || 0;
    }
    done = item.eventId;
  }
  return done;
}

// ── One run ────────────────────────────────────────────────────────────
async function liveOpenConfig(uuid: string): Promise<Config | null> {
  const runtime = require('../setup/runtime.ts');
  const store = await runtime.getSetupStore();
  const opened = store ? await store.resolveByUuid(uuid) : null;
  if (!opened) return null;
  const engine = (require('../setup/config-store.ts') as { toEngineConfig: (o: unknown) => Config }).toEngineConfig(opened);
  Object.defineProperty(engine, '__configScope', { value: { type: 'config', uuid: opened.uuid, tier: opened.tier }, enumerable: false, configurable: true });
  return engine;
}

async function nuvioProfile(rpc: Rpc, config: Config): Promise<number> {
  const data = await rpc('sync_pull_profiles');
  const list = (Array.isArray(data) ? data : asRecord(data)['profiles']) as unknown[] | undefined;
  const profiles = (Array.isArray(list) ? list : []).map(asRecord).map((row) => ({ ...row, profile_index: Math.trunc(Number(row['profile_index'])) }));
  const { resolveNuvioProfile } = require('../setup/push.ts') as { resolveNuvioProfile: (p: unknown[], s: unknown) => { ok: boolean; profile?: { profile_index: number } } };
  const resolved = resolveNuvioProfile(profiles, asRecord(asRecord(config['push'])['nuvio'])['nuvioSelectedProfile']);
  if (!resolved.ok || !resolved.profile) throw new Error('Nuvio profile not found');
  return resolved.profile.profile_index;
}

async function runSync(payload: { uuid?: string }, deps: SyncDeps = {}): Promise<'done'> {
  const uuid = String((payload && payload.uuid) || '').toLowerCase();
  if (!uuid) return 'done';
  const ctx = rt.withContext(deps.ctx);
  await ctx.store.set(lastRunKey(uuid), ctx.now(), MARK_TTL_S).catch(() => {});
  const config = await (deps.openConfig || liveOpenConfig)(uuid);
  if (!config) return 'done';
  const targets = cfg.effectiveWatchHistory(config).sync;
  if (!targets.length) return 'done';
  const rpc = (deps.nuvioRpc || ((c: Config) => (require('./reader.ts') as { liveNuvioRpc: (c: Config) => Rpc | null }).liveNuvioRpc(c)))(config);
  if (!rpc) return 'done';
  const profile = await nuvioProfile(rpc, config);
  const head = Number(await rpc('sync_get_watched_items_delta_cursor', { p_profile_id: profile })) || 0;
  const now = ctx.now();
  // The first copy for a service (or a changed account) reaches back a year:
  // the finished plays that already exist are worth copying, but never a
  // years-old library. Older events are skipped yet still move the mark.
  const backfillFrom = now - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  // Marks per service; a new or changed account starts its copy at the oldest
  // event the feed still has.
  const marks = new Map<SyncTarget, SyncMark>();
  for (const target of targets) {
    const fp = targetFp(config, target);
    const stored = await ctx.store.get(markKey(uuid, target)).catch(() => null) as SyncMark | null;
    if (!stored || stored.fp !== fp || !Number.isFinite(Number(stored.cursor))) {
      const fresh: SyncMark = { cursor: 0, fp, sent: [], at: now };
      await ctx.store.set(markKey(uuid, target), fresh, MARK_TTL_S).catch(() => {});
      marks.set(target, fresh);
      continue;
    }
    if (stored.waitUntil && stored.waitUntil > now) continue;
    if (Number(stored.cursor) < head) marks.set(target, stored);
  }
  if (!marks.size) return 'done';
  // One delta read from the lowest mark, shared by every service.
  const from = Math.min(...[...marks.values()].map((mark) => Number(mark.cursor)));
  const events: unknown[] = [];
  let since = from;
  for (let page = 0; page < DELTA_MAX_PAGES; page++) {
    const rows = await rpc('sync_pull_watched_items_delta', { p_profile_id: profile, p_since_event_id: since, p_limit: DELTA_PAGE });
    const list = Array.isArray(rows) ? rows : [];
    events.push(...list);
    const max = Math.max(since, ...list.map((row) => Number(asRecord(row)['event_id']) || 0));
    if (list.length < DELTA_PAGE || max <= since) break;
    since = max;
  }
  const allIds = events.map((row) => Number(asRecord(row)['event_id']) || 0);
  const lastEvent = Math.max(from, ...allIds);
  const items = events.map(itemFromEvent).filter((item): item is SyncItem => item !== null).sort((a, b) => a.eventId - b.eventId);
  for (const [target, mark] of marks) {
    const sent = new Set(mark.sent || []);
    const pending = items.filter((item) => item.eventId > Number(mark.cursor) && !sent.has(item.key)
      && Date.parse(item.watchedAt) >= backfillFrom);
    try {
      const done = !pending.length ? -1
        : target === 'simkl' ? await writeSimkl(ctx, config, pending, deps)
          : target === 'mdblist' ? await writeMdblist(ctx, config, pending)
            : await writeAnilist(ctx, config, pending, mark, deps);
      if (done === null) continue;
      const handled = pending.filter((item) => item.eventId <= done);
      // Everything up to the last item handled; with nothing left over,
      // everything read (removals and unmappable rows included).
      const cursor = handled.length === pending.length ? lastEvent : Math.max(Number(mark.cursor), done);
      const nextSent = [...(mark.sent || []), ...handled.map((item) => item.key)].slice(-SENT_MAX);
      const next: SyncMark = { cursor, fp: mark.fp, sent: nextSent, at: ctx.now() };
      if (mark.progress) next.progress = mark.progress;
      await ctx.store.set(markKey(uuid, target), next, MARK_TTL_S).catch(() => {});
    } catch (err) {
      const status = rt.statusOf(err);
      const wait = status === 429 ? rt.retryAfterSeconds(err) : 15 * 60;
      ctx.log(`[watch-history] sync to ${target} failed: status=${status || 'network'}`);
      await ctx.store.set(markKey(uuid, target), { ...mark, waitUntil: ctx.now() + wait * 1000 }, MARK_TTL_S).catch(() => {});
    }
  }
  return 'done';
}

// ── Scheduling (active setups only) ────────────────────────────────────
const noted = new Map<string, number>();

// Called on a catalogue request: queue this setup's next sync run (about
// every SYNC_EVERY_MS) when it copies history anywhere. Cheap: a memory
// throttle, then one job lookup.
async function noteActive(config: Config, deps: SyncDeps = {}): Promise<boolean> {
  const { setupUuid } = require('./reader.ts') as { setupUuid: (c: Config) => string };
  const uuid = setupUuid(config);
  if (!uuid || !cfg.effectiveWatchHistory(config).sync.length) return false;
  const ctx = rt.withContext(deps.ctx);
  const now = ctx.now();
  const last = noted.get(uuid);
  if (last !== undefined && now - last < NOTE_GAP_MS) return false;
  boundedSet(noted, uuid, now, 5000, (at) => now - at >= NOTE_GAP_MS);
  const jobs = deps.jobs || require('../runtime/jobs.ts');
  if (jobs.jobState(JOB_KIND, uuid)) return false;
  const ran = Number(await ctx.store.get(lastRunKey(uuid)).catch(() => 0)) || 0;
  const delayMs = Math.max(0, ran + SYNC_EVERY_MS - now);
  await jobs.scheduleJob({ kind: JOB_KIND, id: uuid, payload: { uuid }, delayMs }).catch(() => {});
  return true;
}

// Test seam.
function resetSync(): void {
  noted.clear();
  anilistSent.length = 0;
}

// Registered at require time so the runner has the handler before it starts.
require('../runtime/jobs.ts').registerJobHandler(JOB_KIND, (payload: { uuid?: string }) => runSync(payload));

export interface WatchHistorySyncApi {
  JOB_KIND: string;
  SYNC_EVERY_MS: number;
  ANILIST_SYNC_PER_MIN: number;
  itemFromEvent: typeof itemFromEvent;
  historyBody: typeof historyBody;
  anilistMediaId: typeof anilistMediaId;
  takeAnilistSlot: typeof takeAnilistSlot;
  runSync: typeof runSync;
  noteActive: typeof noteActive;
  resetSync: typeof resetSync;
  markKey: typeof markKey;
}

module.exports = {
  JOB_KIND, SYNC_EVERY_MS, ANILIST_SYNC_PER_MIN, itemFromEvent, historyBody, anilistMediaId, takeAnilistSlot, runSync, noteActive, resetSync, markKey,
} satisfies WatchHistorySyncApi;
