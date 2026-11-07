// @ts-nocheck
'use strict';
// Watch history (v6): settings, id normalisation, the reader (Nuvio,
// MDBList gate), Hide watched, the history rows and the Nuvio -> services
// sync. Fakes only: fake Nuvio RPCs, fake http, an in-memory store; every
// key and token is synthetic and nothing reaches Nuvio, Simkl, MDBList,
// AniList or TMDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

const cfg = require('../src/watch-history/config.ts');
const ids = require('../src/watch-history/ids.ts');
const reader = require('../src/watch-history/reader.ts');
const sync = require('../src/watch-history/sync.ts');
const watchHistory = require('../src/watch-history/index.ts');
const rt = require('../src/user-lists/runtime.ts');
const rows = require('../src/user-lists/rows.ts');

const UUID = '00000000-0000-4000-8000-0000000000bb';
const UUID_2 = '00000000-0000-4000-8000-0000000000cc';
const MDB_KEY = 'syntheticMdblistKeyWatch';

function fakeStore(clock) {
  const data = new Map();
  const expires = new Map();
  const now = () => (clock ? clock.t : Date.now());
  return {
    data,
    get: async (key) => {
      if (!data.has(key)) return null;
      if (expires.get(key) <= now()) { data.delete(key); return null; }
      return structuredClone(data.get(key));
    },
    set: async (key, value, ttl) => { data.set(key, structuredClone(value)); expires.set(key, now() + ttl * 1000); return true; },
  };
}

function fakeHttp(handler) {
  const calls = [];
  const run = async (method, url, options = {}, body) => {
    calls.push({ method, url, options, body });
    const out = await handler(method, url, options, body);
    if (out instanceof Error) throw out;
    return out;
  };
  return { calls, get: (url, options) => run('GET', url, options), post: (url, body, options) => run('POST', url, options, body) };
}

function context(http, clock = { t: 1_800_000_000_000 }) {
  const store = fakeStore(clock);
  const logs = [];
  return { ctx: { http, store, now: () => clock.t, log: (line) => logs.push(line) }, store, clock, logs };
}

function engineConfig(extra = {}, uuid = UUID) {
  const config = {
    tmdbApiKey: 'synthetic-tmdb',
    push: { nuvio: { nuvioToken: 'synthetic-nuvio-session', nuvioUser: { id: `user-${uuid}` }, nuvioSelectedProfile: 1 } },
    ...extra,
  };
  Object.defineProperty(config, '__configScope', { value: { type: 'config', uuid, tier: 'partial' }, enumerable: false });
  return config;
}

// A fake Nuvio account: watched items, progress and the delta feed.
function fakeNuvio({ watched = [], progress = [], events = [] } = {}) {
  const calls = [];
  const state = { watched, progress, events, cursor: events.length ? Math.max(...events.map((e) => e.event_id)) : 0 };
  const rpc = async (name, body = {}) => {
    calls.push({ name, body });
    if (name === 'sync_pull_profiles') return [{ profile_index: 1, name: 'Main' }, { profile_index: 2, name: 'Kids' }];
    if (name === 'sync_get_watched_items_delta_cursor') return state.cursor;
    if (name === 'sync_get_watch_progress_delta_cursor') return 7;
    if (name === 'sync_pull_watched_items') return body.p_page === 1 ? state.watched : [];
    if (name === 'sync_pull_watch_progress') return state.progress;
    if (name === 'sync_pull_watched_items_delta') return state.events.filter((e) => e.event_id > body.p_since_event_id).slice(0, body.p_limit);
    throw new Error(`unexpected rpc ${name}`);
  };
  return { rpc, calls, state };
}

const TV = {
  100: { name: 'Show Hundred', poster: '/p100.jpg', seasons: [{ n: 1, count: 3 }, { n: 2, count: 2 }], last: { s: 2, e: 1 }, imdb: 'tt0000100' },
  200: { name: 'Show Two', poster: null, seasons: [{ n: 1, count: 2 }], last: { s: 1, e: 2 }, imdb: 'tt0000200' },
};

function readerDeps(nuvio, ctx, extra = {}) {
  return {
    ctx,
    nuvioRpc: () => nuvio.rpc,
    tvInfo: async (id) => TV[id] || null,
    movieInfo: async (id) => ({ title: `Film ${id}`, poster: null, imdb: `tt${String(id).padStart(7, '0')}` }),
    imdbToTmdb: async (imdb) => (imdb === 'tt1234567' ? 555 : null),
    tmdbToImdb: async (_type, list) => new Map(list.map((id) => [id, `tt9${String(id).padStart(6, '0')}`])),
    ...extra,
  };
}

// A stale state is served at once and rebuilt in the background: let it finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test.beforeEach(() => {
  rt.resetRuntime();
  reader.resetReader();
  sync.resetSync();
});

// ── Settings ──────────────────────────────────────────────────────────────
test('settings: defaults are never written; only differences are stored', () => {
  assert.equal(cfg.compactWatchHistory(undefined), null);
  assert.equal(cfg.compactWatchHistory({}), null);
  assert.equal(cfg.compactWatchHistory(cfg.DEFAULTS), null);
  assert.deepEqual(cfg.compactWatchHistory({ hideWatched: true, sources: { simkl: { sync: true, history: true }, mdblist: { history: false } } }), {
    sources: { simkl: { sync: true } },
    hideWatched: true,
  });
  const full = cfg.normalizeWatchHistory({ sources: { nuvio: { history: 'yes' } } });
  assert.equal(full.sources.nuvio.history, true, 'junk falls back to the default');
  assert.equal(full.sources.mdblist.history, false, 'MDBList history is off by default');
  assert.equal(full.hideWatched, false, 'Hide watched is off by default');
  for (const name of ['simkl', 'mdblist', 'anilist']) assert.equal(full.sources[name].sync, false, `${name} sync is off by default`);
});

test('card visibility: no source -> nothing; MDBList only with a key; Nuvio needs a saved login', () => {
  assert.deepEqual(cfg.availableHistorySources({}), { nuvio: false, simkl: false, mdblist: false, anilist: false });
  const none = cfg.effectiveWatchHistory({ tmdbApiKey: 'x' });
  assert.deepEqual(none.read, []);
  assert.equal(none.hideWatched, false);
  assert.equal(cfg.availableHistorySources({ mdblistKey: MDB_KEY }).mdblist, true);
  // MDBList is available but its history is off until switched on.
  assert.deepEqual(cfg.effectiveWatchHistory({ mdblistKey: MDB_KEY }).read, []);
  assert.deepEqual(cfg.effectiveWatchHistory({ mdblistKey: MDB_KEY, watchHistory: { sources: { mdblist: { history: true } } } }).read, ['mdblist']);
  assert.deepEqual(cfg.effectiveWatchHistory(engineConfig()).read, ['nuvio']);
  // Hide watched needs something to decide from.
  assert.equal(cfg.effectiveWatchHistory({ watchHistory: { hideWatched: true } }).hideWatched, false);
  assert.equal(cfg.effectiveWatchHistory(engineConfig({ watchHistory: { hideWatched: true } })).hideWatched, true);
  // Sync copies FROM Nuvio: no Nuvio, no sync.
  assert.deepEqual(cfg.effectiveWatchHistory({ mdblistKey: MDB_KEY, watchHistory: { sources: { mdblist: { sync: true } } } }).sync, []);
  assert.deepEqual(cfg.effectiveWatchHistory(engineConfig({ mdblistKey: MDB_KEY, watchHistory: { sources: { mdblist: { sync: true } } } })).sync, ['mdblist']);
  // The rows exist only while a history source is on.
  assert.equal(rows.userListServices(engineConfig()).history, true);
  assert.equal(rows.userListServices(engineConfig({ watchHistory: { sources: { nuvio: { history: false } } } })).history, false);
});

test('the browser defaults mirror the server defaults', async () => {
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  const mod = await import(pathToFileURL(path.join(__dirname, '../../frontend/src/features/setup/shared/watch-history.ts')).href);
  assert.deepEqual(mod.DEFAULT_WATCH_HISTORY, cfg.DEFAULTS);
  for (const value of [{}, { hideWatched: true }, { sources: { simkl: { sync: true }, nuvio: { history: false } } }]) {
    assert.deepEqual(mod.watchHistoryForConfig(mod.cleanWatchHistory(value)), cfg.compactWatchHistory(value));
  }
});

test('saving default settings clears the stored key; other values are stored compact', async () => {
  const { mountSetupRoutes } = require('../src/routes/setup.ts');
  const { createEditSessionStore } = require('../src/setup/edit-sessions.ts');
  const sessions = createEditSessionStore();
  const setup = { uuid: UUID, tier: 'partial', name: null, hasPassword: true, config: { lang: 'en-US', watchHistory: { hideWatched: true } }, keys: { tmdbApiKey: 'x' }, secret: 's', createdAt: null, updatedAt: null };
  const app = express();
  mountSetupRoutes(app, {
    editSessions: sessions,
    getStore: async () => ({
      resolveByUuid: async (uuid) => (uuid === UUID ? setup : null),
      resolveByToken: async () => null,
      checkPassword: async () => false,
      toEngineConfig: (o) => ({ ...o.config, ...o.keys }),
      save: async (_uuid, patch) => {
        if (patch.config) setup.config = { ...setup.config, ...patch.config };
        for (const key of patch.clearConfig ?? []) delete setup.config[key];
        return { ...setup };
      },
    }),
    identities: async () => ({}),
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = sessions.issue(UUID).token;
    const put = (config) => fetch(`${base}/api/setup/${UUID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ config }) });
    assert.equal((await put({ watchHistory: { hideWatched: false, sources: { nuvio: { history: true } } } })).status, 200);
    assert.equal('watchHistory' in setup.config, false, 'defaults clear the key');
    assert.equal((await put({ watchHistory: { hideWatched: true, sources: { mdblist: { history: false, sync: true } } } })).status, 200);
    assert.deepEqual(setup.config.watchHistory, { sources: { mdblist: { sync: true } }, hideWatched: true });
  } finally { server.close(); }
});

// ── Ids ───────────────────────────────────────────────────────────────────
test('ids: library, discovery, tmdb and episode ids map to canonical keys', () => {
  assert.deepEqual(ids.parseContentId('torbox:movie:603'), { type: 'movie', tmdb: 603, imdb: null, other: null, season: null, episode: null });
  assert.deepEqual(ids.parseContentId('torbox:series:1399:2:5'), { type: 'series', tmdb: 1399, imdb: null, other: null, season: 2, episode: 5 });
  assert.deepEqual(ids.parseContentId('tt0133093', 'movie'), { type: 'movie', tmdb: null, imdb: 'tt0133093', other: null, season: null, episode: null });
  assert.deepEqual(ids.parseContentId('tt0944947:1:3', 'series'), { type: 'series', tmdb: null, imdb: 'tt0944947', other: null, season: 1, episode: 3 });
  // Season/episode columns (Nuvio's watched rows) win over nothing in the id.
  assert.deepEqual(ids.parseContentId('tt0944947', 'series', 4, 2), { type: 'series', tmdb: null, imdb: 'tt0944947', other: null, season: 4, episode: 2 });
  assert.deepEqual(ids.parseContentId('tmdb:movie:27205'), { type: 'movie', tmdb: 27205, imdb: null, other: null, season: null, episode: null });
  assert.deepEqual(ids.parseContentId('tmdb:42', 'tv'), { type: 'series', tmdb: 42, imdb: null, other: null, season: null, episode: null });
  assert.equal(ids.parseContentId('kitsu:7442:3', 'series').other, 'kitsu:7442');
  assert.equal(ids.parseContentId('torbox:movie:abc'), null);
  assert.equal(ids.parseContentId('', 'movie'), null);
  assert.equal(ids.episodeKey(1399, 2, 5), 'series:tmdb:1399:s2e5');
  // A catalogue meta is matched by its id, tmdbId and IMDb id.
  assert.deepEqual(ids.metaKeys({ id: 'torbox:movie:603', type: 'movie' }), ['movie:tmdb:603']);
  assert.deepEqual(ids.metaKeys({ id: 'tt0133093', type: 'movie', tmdbId: 603 }).sort(), ['movie:imdb:tt0133093', 'movie:tmdb:603']);
  assert.deepEqual(ids.metaKeys({ id: 'torbox:series:1399', type: 'series', imdb_id: 'tt0944947' }).sort(), ['series:imdb:tt0944947', 'series:tmdb:1399']);
});

// ── Reader ────────────────────────────────────────────────────────────────
test('completed at 90%: 0.89 is Continue Watching, 0.90 is watched', async () => {
  const snap = await reader.nuvioSnapshot({
    watched: [],
    progress: [
      { id: 'tmdb:movie:11', type: 'movie', season: null, episode: null, position: 89, duration: 100, at: 2000 },
      { id: 'tmdb:movie:12', type: 'movie', season: null, episode: null, position: 90, duration: 100, at: 1000 },
      { id: 'tmdb:movie:13', type: 'movie', season: null, episode: null, position: 1, duration: 100, at: 3000 },
    ],
  }, { tvInfo: async () => null, movieInfo: async (id) => ({ title: `Film ${id}`, poster: null, imdb: null }), imdbToTmdb: async () => null });
  assert.ok(snap.watched.includes('movie:tmdb:12'));
  assert.ok(!snap.watched.includes('movie:tmdb:11'));
  assert.deepEqual(snap.continue.map((item) => item.tmdb), [11], 'a 1% start is not something to continue');
  assert.equal(snap.continue[0].title, 'Film 11');
  assert.equal(snap.continue[0].pct, 0.89);
});

test('Nuvio shows: caught up on the last aired episode; otherwise the next aired episode', async () => {
  const snap = await reader.nuvioSnapshot({
    watched: [
      // Show 100: watched S01E01-E03 -> next is S02E01 (aired).
      { id: 'torbox:series:100', type: 'series', title: 'Show Hundred', season: 1, episode: 1, at: 10 },
      { id: 'torbox:series:100', type: 'series', title: 'Show Hundred', season: 1, episode: 2, at: 20 },
      { id: 'torbox:series:100', type: 'series', title: 'Show Hundred', season: 1, episode: 3, at: 30 },
      // Show 200: watched the last aired episode -> caught up.
      { id: 'tmdb:200', type: 'series', title: 'Show Two', season: 1, episode: 2, at: 40 },
      // A film by IMDb id only: its TMDB id is looked up too.
      { id: 'tt1234567', type: 'movie', title: 'Imdb Film', season: null, episode: null, at: 50 },
    ],
    progress: [],
  }, { tvInfo: async (id) => TV[id] || null, movieInfo: async () => null, imdbToTmdb: async (imdb) => (imdb === 'tt1234567' ? 555 : null) });
  assert.ok(snap.caughtUp.includes('series:tmdb:200'));
  assert.ok(snap.caughtUp.includes('series:imdb:tt0000200'));
  assert.ok(!snap.caughtUp.includes('series:tmdb:100'));
  assert.deepEqual(snap.upnext.map((item) => [item.tmdb, item.season, item.episode]), [[100, 2, 1]]);
  assert.ok(snap.watched.includes('movie:imdb:tt1234567') && snap.watched.includes('movie:tmdb:555'));
  assert.deepEqual(reader.nextEpisode(TV[100], 2, 1), null, 'S02E02 has not aired');
});

test('reader: the selected Nuvio profile, delta cursors gate the pull, state per setup', async () => {
  const nuvio = fakeNuvio({ watched: [{ content_id: 'torbox:movie:603', content_type: 'movie', title: 'The Matrix', watched_at: 1_700_000_000_000 }] });
  const http = fakeHttp(() => { throw new Error('no http'); });
  const { ctx, clock } = context(http);
  const config = engineConfig({ watchHistory: { hideWatched: true } });
  const first = await reader.historyFor(config, { waitMs: 5000 }, readerDeps(nuvio, ctx));
  assert.ok(first.watched.includes('movie:tmdb:603'));
  assert.ok(first.watched.includes('movie:imdb:tt9000603'), 'the other id is added for discovery rows');
  const pulls = (name) => nuvio.calls.filter((call) => call.name === name).length;
  assert.equal(pulls('sync_pull_watched_items'), 1);
  assert.ok(nuvio.calls.filter((call) => call.name === 'sync_pull_watched_items').every((call) => call.body.p_profile_id === 1));
  // Within 10 minutes: served from memory, nothing asked.
  const before = nuvio.calls.length;
  await reader.historyFor(config, {}, readerDeps(nuvio, ctx));
  assert.equal(nuvio.calls.length, before);
  // Later, unchanged cursors: no new pull (only the cheap cursor reads).
  clock.t += 11 * 60 * 1000;
  reader.resetReader();
  await reader.historyFor(config, { waitMs: 5000 }, readerDeps(nuvio, ctx));
  await settle();
  assert.equal(pulls('sync_pull_watched_items'), 1);
  assert.ok(pulls('sync_get_watched_items_delta_cursor') >= 1);
  // Another setup never sees this one's state.
  const other = await reader.historyFor(engineConfig({}, UUID_2), { waitMs: 5000 }, readerDeps(fakeNuvio(), ctx));
  assert.deepEqual(other.watched, []);
  assert.notEqual(reader.stateFingerprint(config, ['nuvio']), reader.stateFingerprint(engineConfig({}, UUID_2), ['nuvio']));
});

test('MDBList history is read only when /sync/last_activities changes (user quota)', async () => {
  let stamp = 'A';
  const http = fakeHttp((method, url) => {
    if (url.endsWith('/sync/last_activities')) return { data: { watched_at: stamp } };
    if (url.endsWith('/sync/watched')) return { data: { movies: [{ id: 1, tmdb: 603, last_watched_at: 'x' }], shows: [{ tmdb: 1399, completed: true }, { tmdb: 77, inprogress: true }] } };
    if (url.endsWith('/sync/playback')) return { data: [] };
    if (url.endsWith('/upnext')) return { data: { items: [] } };
    throw new Error(`unexpected ${url}`);
  });
  const { ctx, clock } = context(http);
  const config = { mdblistKey: MDB_KEY, tmdbApiKey: 'x', watchHistory: { sources: { mdblist: { history: true } } } };
  const deps = { ctx, tmdbToImdb: async () => new Map() };
  const state = await reader.historyFor(config, { waitMs: 5000 }, deps);
  assert.ok(state.watched.includes('movie:tmdb:603'));
  assert.ok(state.caughtUp.includes('series:tmdb:1399'));
  assert.ok(!state.caughtUp.includes('series:tmdb:77'), 'in progress is not caught up');
  const watchedReads = () => http.calls.filter((call) => call.url.endsWith('/sync/watched')).length;
  assert.equal(watchedReads(), 1);
  assert.equal(http.calls.find((call) => call.url.endsWith('/sync/watched')).options.params.extended, 'ids_only');
  // An hour later, same stamp: no new read.
  clock.t += 61 * 60 * 1000;
  reader.resetReader();
  await reader.historyFor(config, { waitMs: 5000 }, deps);
  await settle();
  assert.equal(watchedReads(), 1);
  // A new stamp: read again.
  stamp = 'B';
  clock.t += 61 * 60 * 1000;
  reader.resetReader();
  await reader.historyFor(config, { waitMs: 5000 }, deps);
  await settle();
  assert.equal(watchedReads(), 2);
});

// ── Hide watched ──────────────────────────────────────────────────────────
test('hide watched: per request on a copy, library and discovery rows alike, never the cached page', async () => {
  const nuvio = fakeNuvio({ watched: [
    { content_id: 'torbox:movie:603', content_type: 'movie', title: 'The Matrix', watched_at: 1 },
    { content_id: 'tmdb:200', content_type: 'series', title: 'Show Two', season: 1, episode: 2, watched_at: 2 },
  ] });
  const { ctx } = context(fakeHttp(() => { throw new Error('no http'); }));
  const config = engineConfig({ watchHistory: { hideWatched: true } });
  const deps = readerDeps(nuvio, ctx);
  const filter = await watchHistory.hideWatchedFilter(config, 'torbox-trending-movies', deps);
  assert.equal(typeof filter, 'function');
  // A page as a shared cache would hold it (frozen: must not be mutated).
  const cached = Object.freeze([
    Object.freeze({ id: 'torbox:movie:603', type: 'movie' }),
    Object.freeze({ id: 'tt9000603', type: 'movie' }),
    Object.freeze({ id: 'tt0000001', type: 'movie' }),
    Object.freeze({ id: 'torbox:series:200', type: 'series' }),
    Object.freeze({ id: 'tt0000200', type: 'series' }),
    Object.freeze({ id: 'torbox:series:100', type: 'series' }),
  ]);
  const out = filter(cached);
  assert.deepEqual(out.map((m) => m.id), ['tt0000001', 'torbox:series:100']);
  assert.equal(cached.length, 6, 'the cached page is untouched');
  // Search and personal rows are never filtered; off = no filter at all.
  assert.equal(await watchHistory.hideWatchedFilter(config, 'lelibrary-search-movies', deps), null);
  assert.equal(await watchHistory.hideWatchedFilter(config, 'lelibrary-user-simkl-completed-movie', deps), null);
  assert.equal(await watchHistory.hideWatchedFilter(engineConfig(), 'torbox-trending-movies', deps), null);
  // Another setup on the same shared page gets its own (empty) answer.
  const otherFilter = await watchHistory.hideWatchedFilter(engineConfig({ watchHistory: { hideWatched: true } }, UUID_2), 'torbox-trending-movies', readerDeps(fakeNuvio(), ctx));
  assert.equal(otherFilter, null);
});

test('history rows: Continue Watching and Up Next as list items with notes', () => {
  const state = {
    v: 1, builtAt: 0, version: 'x', watched: [], caughtUp: [], sources: ['nuvio'],
    continue: [
      { type: 'movie', tmdb: 11, imdb: 'tt0000011', title: 'Film', pct: 0.42, at: 2 },
      { type: 'series', tmdb: 100, imdb: null, title: 'Show', season: 1, episode: 3, pct: 0.5, at: 1 },
    ],
    upnext: [{ type: 'series', tmdb: 100, imdb: 'tt0000100', title: 'Show', season: 2, episode: 1, at: 1 }],
  };
  assert.deepEqual(reader.historyRowItems(state, 'continue', 'movie').map((i) => [i.tmdb, i.note]), [[11, '42%']]);
  assert.deepEqual(reader.historyRowItems(state, 'continue', 'series').map((i) => i.note), ['S01E03 · 50%']);
  assert.deepEqual(reader.historyRowItems(state, 'upnext', 'series').map((i) => i.note), ['Next: S02E01']);
  assert.deepEqual(reader.historyRowItems(null, 'upnext', 'series'), []);
  assert.deepEqual(rows.parseUserListId('lelibrary-user-history-continue-movie'), { provider: 'history', list: 'continue', type: 'movie' });
  assert.deepEqual(rows.parseUserListId('lelibrary-user-history-upnext-series'), { provider: 'history', list: 'upnext', type: 'series' });
  assert.equal(rows.parseUserListId('lelibrary-user-history-upnext-movie'), null);
});

test('draft preview: history rows are labelled samples, declared with a Nuvio login name', async () => {
  const { buildDraftCatalog } = require('../src/setup/preview.ts');
  const out = await buildDraftCatalog({ type: 'series', catalogId: 'lelibrary-user-history-upnext-series', config: {} }, { serverKey: () => { throw new Error('must not build'); } });
  assert.equal(out.body.sample, true);
  assert.equal(out.body.reason, 'personal');
  assert.equal(out.body.service, 'history');
});

// ── Sync ──────────────────────────────────────────────────────────────────
function syncDeps(nuvio, ctx, config, extra = {}) {
  return { ctx, openConfig: async () => config, nuvioRpc: () => nuvio.rpc, ...extra };
}

test('sync: starts at the head (no backfill), sends each finished item once, with its real watched_at', async () => {
  const event = (id, extra) => ({ event_id: id, operation: 'upsert', content_type: 'movie', title: 'x', watched_at: 1_700_000_000_000 + id, ...extra });
  const nuvio = fakeNuvio({ events: [event(1, { content_id: 'torbox:movie:1' }), event(2, { content_id: 'tt0000002' })] });
  const posts = [];
  const http = fakeHttp((method, url, options, body) => { posts.push({ url, options, body }); return { data: {} }; });
  const { ctx, store } = context(http);
  const config = engineConfig({ mdblistKey: MDB_KEY, watchHistory: { sources: { mdblist: { sync: true } } } });
  await sync.runSync({ uuid: UUID }, syncDeps(nuvio, ctx, config));
  assert.equal(posts.length, 0, 'switching sync on sends nothing from before');
  assert.equal((await store.get(sync.markKey(UUID, 'mdblist'))).cursor, 2);
  // New finished items arrive.
  nuvio.state.events.push(
    event(3, { content_id: 'torbox:movie:3' }),
    { event_id: 4, operation: 'upsert', content_id: 'torbox:series:1399', content_type: 'series', season: 1, episode: 2, watched_at: 1_700_000_100_000 },
    { event_id: 5, operation: 'delete', content_id: 'torbox:movie:9', content_type: 'movie', watched_at: 0 },
  );
  nuvio.state.cursor = 5;
  await sync.runSync({ uuid: UUID }, syncDeps(nuvio, ctx, config));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.mdblist.com/sync/watched');
  assert.equal(posts[0].options.params.apikey, MDB_KEY);
  assert.deepEqual(posts[0].body.movies, [{ ids: { tmdb: 3 }, watched_at: new Date(1_700_000_000_003).toISOString().replace(/\.\d{3}Z$/, 'Z') }]);
  assert.deepEqual(posts[0].body.shows, [{ ids: { tmdb: 1399 }, seasons: [{ number: 1, episodes: [{ number: 2, watched_at: new Date(1_700_000_100_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }] }] }]);
  assert.equal((await store.get(sync.markKey(UUID, 'mdblist'))).cursor, 5);
  // Nothing new: nothing sent. Even a replayed event is not sent again.
  await sync.runSync({ uuid: UUID }, syncDeps(nuvio, ctx, config));
  assert.equal(posts.length, 1);
  const mark = await store.get(sync.markKey(UUID, 'mdblist'));
  await store.set(sync.markKey(UUID, 'mdblist'), { ...mark, cursor: 2 }, 3600);
  await sync.runSync({ uuid: UUID }, syncDeps(nuvio, ctx, config));
  assert.equal(posts.length, 1, 'the sent list stops duplicates even behind the mark');
});

test('sync: a 429 keeps the mark and waits; Simkl writes only through a V2 grant with media:write', async () => {
  const nuvio = fakeNuvio({ events: [{ event_id: 1, operation: 'upsert', content_id: 'torbox:movie:1', content_type: 'movie', watched_at: 1 }] });
  const posts = [];
  let fail = true;
  const http = fakeHttp((method, url, options, body) => {
    posts.push({ url, options, body });
    if (fail) return Object.assign(new Error('HTTP 429'), { response: { status: 429, headers: { 'retry-after': '120' } } });
    return { data: {} };
  });
  const { ctx, store, clock } = context(http);
  const config = engineConfig({
    watchlist: { simkl: { access_token: 'simkl_at_x', refresh_token: 'simkl_rt_x', auth: 'v2', scope: 'media:read media:write', expires_at: Date.now() + 864e5 * 7 } },
    watchHistory: { sources: { simkl: { sync: true } } },
  });
  process.env.SIMKL_CLIENT_ID ||= 'synthetic-simkl-v2';
  let auth = { token: 'simkl_at_x', clientId: 'synthetic-simkl-v2', kind: 'v2', write: true };
  const deps = syncDeps(nuvio, ctx, config, { simklAuth: async () => auth });
  await sync.runSync({ uuid: UUID }, deps); // initialise at head
  nuvio.state.events.push({ event_id: 2, operation: 'upsert', content_id: 'torbox:movie:2', content_type: 'movie', watched_at: 2 });
  nuvio.state.cursor = 2;
  await sync.runSync({ uuid: UUID }, deps);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.simkl.com/sync/history');
  assert.equal(posts[0].options.headers.Authorization, 'Bearer simkl_at_x');
  const waiting = await store.get(sync.markKey(UUID, 'simkl'));
  assert.equal(waiting.cursor, 1, 'the mark did not move');
  assert.ok(waiting.waitUntil >= clock.t + 119_000);
  // Still waiting: nothing sent.
  fail = false;
  await sync.runSync({ uuid: UUID }, deps);
  assert.equal(posts.length, 1);
  clock.t += 121_000;
  await sync.runSync({ uuid: UUID }, deps);
  assert.equal(posts.length, 2);
  assert.equal((await store.get(sync.markKey(UUID, 'simkl'))).cursor, 2);
  // A read-only (or V1) grant never writes.
  auth = { ...auth, write: false };
  nuvio.state.events.push({ event_id: 3, operation: 'upsert', content_id: 'torbox:movie:3', content_type: 'movie', watched_at: 3 });
  nuvio.state.cursor = 3;
  await sync.runSync({ uuid: UUID }, deps);
  assert.equal(posts.length, 2);
});

test('AniList sync: a server-wide bucket under 30/min, only titles that map to one AniList entry', async () => {
  const now = 5_000_000;
  let allowed = 0;
  while (sync.takeAnilistSlot(now)) allowed += 1;
  assert.equal(allowed, sync.ANILIST_SYNC_PER_MIN);
  assert.ok(sync.ANILIST_SYNC_PER_MIN < 30);
  assert.equal(sync.takeAnilistSlot(now + 59_000), false);
  assert.equal(sync.takeAnilistSlot(now + 60_001), true);
  const map = { 10: { tv: 500, imdb: 'tt0000500' }, 11: { movie: 600 }, 12: { tv: 700 }, 13: { tv: 700 } };
  const item = (extra) => ({ eventId: 1, tmdb: null, imdb: null, season: null, episode: null, watchedAt: 'x', key: 'k', ...extra });
  assert.equal(sync.anilistMediaId(item({ type: 'series', tmdb: 500, season: 1, episode: 3 }), map), 10);
  assert.equal(sync.anilistMediaId(item({ type: 'series', imdb: 'tt0000500', season: 1, episode: 3 }), map), 10);
  assert.equal(sync.anilistMediaId(item({ type: 'series', tmdb: 500, season: 2, episode: 3 }), map), null, 'later seasons are separate AniList entries');
  assert.equal(sync.anilistMediaId(item({ type: 'series', tmdb: 700, season: 1, episode: 1 }), map), null, 'ambiguous: skipped, never guessed');
  assert.equal(sync.anilistMediaId(item({ type: 'movie', tmdb: 600 }), map), 11);
  assert.equal(sync.anilistMediaId(item({ type: 'movie', tmdb: 999 }), map), null);
});

test('sync scheduling: only setups that copy history, only when active, about every 30 minutes', async () => {
  const scheduled = [];
  const jobs = { jobState: () => null, scheduleJob: async (input) => { scheduled.push(input); } };
  const { ctx, store, clock } = context(fakeHttp(() => ({})));
  assert.equal(await sync.noteActive(engineConfig(), { ctx, jobs }), false, 'no sync target, nothing scheduled');
  const config = engineConfig({ mdblistKey: MDB_KEY, watchHistory: { sources: { mdblist: { sync: true } } } });
  assert.equal(await sync.noteActive(config, { ctx, jobs }), true);
  assert.equal(scheduled[0].kind, sync.JOB_KIND);
  assert.equal(scheduled[0].delayMs, 0);
  // Right after a run: the next one waits out the interval.
  await store.set(`whist:v1:sync-run:${UUID}`, clock.t, 3600);
  clock.t += 2 * 60 * 1000;
  assert.equal(await sync.noteActive(config, { ctx, jobs }), true);
  assert.equal(scheduled[1].delayMs, sync.SYNC_EVERY_MS - 2 * 60 * 1000);
  // A job already queued is left alone.
  clock.t += 2 * 60 * 1000;
  assert.equal(await sync.noteActive(config, { ctx, jobs: { ...jobs, jobState: () => ({}) } }), false);
});
