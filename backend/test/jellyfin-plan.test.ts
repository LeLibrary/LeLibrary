// @ts-nocheck
'use strict';
// The Jellyfin plan contract's path, name and key builders. Pure functions: no
// network, no config, no database. Values are pinned by the design doc
// (Docs/plans/2026-11-10-jellyfin-plugin-design.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeName, qualityOf, moviePath, episodePath, itemKey } = require('../src/jellyfin/plan.ts');

test('moviePath matches the contract example', () => {
  assert.equal(
    moviePath({ title: 'The Matrix', year: 1999, quality: '2160p', hdr: 'dv' }),
    'The Matrix (1999)/The Matrix (1999) - 2160p DV.strm'
  );
});

test('moviePath drops unknown quality and year', () => {
  assert.equal(moviePath({ title: 'Heat', year: null, quality: null, hdr: null }), 'Heat/Heat.strm');
});

test('episodePath pads season and episode', () => {
  assert.equal(
    episodePath({ seriesTitle: 'The Expanse', seriesYear: 2015, season: 1, episode: 3 }),
    'The Expanse (2015)/Season 01/The Expanse S01E03.strm'
  );
});

test('episodePath keeps a multi-episode file on its first episode', () => {
  assert.equal(
    episodePath({ seriesTitle: 'Show', seriesYear: 2020, season: 2, episode: 4, episodeEnd: 5 }),
    'Show (2020)/Season 02/Show S02E04-E05.strm'
  );
});

test('sanitizeName removes characters Windows and SMB refuse', () => {
  assert.equal(sanitizeName('Mission: Impossible / Fallout?'), 'Mission- Impossible - Fallout-');
  assert.equal(sanitizeName('  Trailing dots...  '), 'Trailing dots');
  assert.equal(sanitizeName('Dr. Strangelove'), 'Dr. Strangelove');
});

test('qualityOf reads quality and HDR from a file name', () => {
  assert.deepEqual(qualityOf('The.Matrix.1999.2160p.DV.HDR.mkv'), { quality: '2160p', hdr: 'dv' });
  assert.deepEqual(qualityOf('Show.S01E01.1080p.WEB.mkv'), { quality: '1080p', hdr: null });
  assert.deepEqual(qualityOf('Film.4K.HDR10+.mkv'), { quality: '2160p', hdr: 'hdr10+' });
  assert.deepEqual(qualityOf('no-quality-here.mkv'), { quality: null, hdr: null });
});

test('itemKey is provider scoped', () => {
  assert.equal(itemKey('torbox', 42, 7), 'torbox:42:7');
  assert.equal(itemKey('realdebrid', 'ABC', 0), 'realdebrid:ABC:0');
});

// ── buildPlan: matched metas -> the plan contract ───────────────────────
const { buildPlan } = require('../src/jellyfin/plan.ts');

const movieItem = (id: number, files: any[]) => ({
  source: 'torrent', id, name: 'The Matrix 1999 2160p DV', size: 20e9, created_at: '2026-01-01',
  files,
});

const movieMeta = (files: any[]) => ({
  id: 'tt0133093', tmdbId: 603, imdbId: 'tt0133093', name: 'The Matrix', year: 1999,
  catalogType: 'movie', poster: '/erdb/poster/tmdb:movie:603',
  torboxItems: [{ item: movieItem(11, files), season: null, episode: null }],
});

test('movies use the largest non-junk video file', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/abc.def',
    metas: [movieMeta([
      { id: 1, name: 'The.Matrix.sample.mkv', size: 5e6 },
      { id: 2, name: 'The.Matrix.2160p.DV.mkv', size: 18e9 },
    ])],
  });
  assert.equal(skipped, 0);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].key, 'torbox:11:2');
  assert.equal(plan.items[0].path, 'The Matrix (1999)/The Matrix (1999) - 2160p DV.strm');
  assert.equal(plan.items[0].poster, 'https://l.uk/abc.def/erdb/poster/tmdb:movie:603');
});

test('a sample-only movie is skipped, never emitted', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/abc.def',
    metas: [movieMeta([{ id: 1, name: 'Film.sample.mkv', size: 5e6 }])],
  });
  assert.equal(plan.items.length, 0);
  assert.equal(skipped, 1);
});

test('an episode is matched to its own file inside a pack', () => {
  const item = {
    source: 'torrent', id: 77, name: 'The Expanse S01 2160p',
    files: [
      { id: 1, name: 'The.Expanse.S01E01.mkv', size: 3e9 },
      { id: 2, name: 'The.Expanse.S01E03.mkv', size: 3e9 },
    ],
  };
  const meta = {
    id: 'tt3230854', tmdbId: 63639, imdbId: 'tt3230854', name: 'The Expanse', year: 2015,
    catalogType: 'series', poster: 'https://img/p.jpg', season: 1, episode: 3,
    torboxItems: [{ item, season: 1, episode: 3 }],
  };
  const { plan } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/abc.def', metas: [meta] });
  const episode = plan.items.find((i: any) => i.kind === 'episode');
  assert.equal(episode.key, 'torbox:77:2');
  assert.equal(episode.path, 'The Expanse (2015)/Season 01/The Expanse S01E03.strm');
  assert.equal(plan.libraries.find((l: any) => l.key === 'shows').kind, 'shows');
});

test('an episode with no matching file is skipped', () => {
  const item = { source: 'torrent', id: 78, name: 'Pack', files: [{ id: 1, name: 'random.mkv', size: 3e9 }] };
  const meta = {
    id: 'tt1', tmdbId: 1, name: 'Show', year: 2020, catalogType: 'series', poster: 'https://img/p.jpg',
    torboxItems: [{ item, season: 1, episode: 2 }],
  };
  const { plan, skipped } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/x', metas: [meta] });
  assert.equal(plan.items.length, 0);
  assert.equal(skipped, 1);
});

test('two copies of one film produce one deterministic path', () => {
  const first = movieMeta([{ id: 2, name: 'The.Matrix.2160p.mkv', size: 18e9 }]);
  const second = {
    ...movieMeta([{ id: 9, name: 'The.Matrix.2160p.mkv', size: 18e9 }]),
    torboxItems: [{
      item: { source: 'torrent', id: 12, name: 'The Matrix 1999 2160p', files: [{ id: 9, name: 'The.Matrix.2160p.mkv', size: 18e9 }] },
      season: null, episode: null,
    }],
  };
  const { plan } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/x', metas: [second, first] });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].key, 'torbox:11:2'); // lowest item id wins, whatever order the metas arrive in
});

test('the plan carries no key material', () => {
  const { plan } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/abc.def',
    metas: [{ ...movieMeta([{ id: 2, name: 'The.Matrix.2160p.mkv', size: 18e9 }]), torboxApiKey: 'SECRET', apiKey: 'SECRET' }],
  });
  const json = JSON.stringify(plan);
  assert.equal(json.includes('SECRET'), false);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.provider, 'torbox');
});

// ── Season packs: a whole-season download must become per-episode items ──
const packMeta = (entry: any, files: any[]) => ({
  id: 'tt222', tmdbId: 2222, name: 'Show', year: 2020, catalogType: 'series',
  poster: 'https://img/p.jpg',
  torboxItems: [{ item: { source: 'torrent', id: 90, name: 'Show S02', files }, ...entry }],
});

test('a season pack expands to one item per episode file', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/x',
    metas: [packMeta({ season: 2, episode: null }, [
      { id: 1, name: 'Show.S02E01.1080p.mkv', size: 2e9 },
      { id: 2, name: 'Show.S02E02.1080p.mkv', size: 2e9 },
      { id: 3, name: 'Show.S02E03.1080p.mkv', size: 2e9 },
    ])],
  });
  assert.equal(skipped, 0);
  assert.deepEqual(plan.items.map((i: any) => i.path), [
    'Show (2020)/Season 02/Show S02E01.strm',
    'Show (2020)/Season 02/Show S02E02.strm',
    'Show (2020)/Season 02/Show S02E03.strm',
  ]);
  assert.deepEqual(plan.items.map((i: any) => i.key), ['torbox:90:1', 'torbox:90:2', 'torbox:90:3']);
});

test('a pack with no season at all still expands from the file names', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/x',
    metas: [packMeta({ season: null, episode: null }, [
      { id: 7, name: 'Show.S01E05.mkv', size: 2e9 },
    ])],
  });
  assert.equal(skipped, 0);
  assert.equal(plan.items[0].path, 'Show (2020)/Season 01/Show S01E05.strm');
  assert.equal(plan.items[0].season, 1);
  assert.equal(plan.items[0].episode, 5);
});

test('a season pack ignores files from another season', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/x',
    metas: [packMeta({ season: 2, episode: null }, [
      { id: 1, name: 'Show.S01E09.mkv', size: 2e9 },
      { id: 2, name: 'Show.S02E04.mkv', size: 2e9 },
    ])],
  });
  assert.equal(skipped, 0);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].path, 'Show (2020)/Season 02/Show S02E04.strm');
});

test('a pack with no parseable episode file is skipped, not guessed', () => {
  const { plan, skipped } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/x',
    metas: [packMeta({ season: 2, episode: null }, [
      { id: 1, name: 'Show.Behind.The.Scenes.mkv', size: 2e9 },
    ])],
  });
  assert.equal(plan.items.length, 0);
  assert.equal(skipped, 1);
});

test('a multi-episode file in a pack stays one item', () => {
  const { plan } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/x',
    metas: [packMeta({ season: 2, episode: null }, [
      { id: 4, name: 'Show.S02E04-E05.mkv', size: 2e9 },
    ])],
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].path, 'Show (2020)/Season 02/Show S02E04-E05.strm');
});

// ── Real meta shape: no `year` field, only releaseInfo ──
test('year comes from releaseInfo when the meta has no year field', () => {
  const meta = movieMeta([{ id: 2, name: 'The.Matrix.2160p.DV.mkv', size: 18e9 }]);
  delete (meta as any).year;
  (meta as any).releaseInfo = '1999-03-31';
  const { plan } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/x', metas: [meta] });
  assert.equal(plan.items[0].year, 1999);
  assert.equal(plan.items[0].path, 'The Matrix (1999)/The Matrix (1999) - 2160p DV.strm');
});

test('a series year comes from a releaseInfo range', () => {
  const meta = {
    id: 'tt3230854', tmdbId: 63639, name: 'The Expanse', releaseInfo: '2015-2022',
    catalogType: 'series', poster: 'https://img/p.jpg',
    torboxItems: [{ item: { source: 'torrent', id: 77, name: 'p', files: [{ id: 2, name: 'The.Expanse.S01E03.mkv', size: 3e9 }] }, season: 1, episode: 3 }],
  };
  const { plan } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/x', metas: [meta] });
  assert.equal(plan.items[0].seriesYear, 2015);
  assert.equal(plan.items[0].path, 'The Expanse (2015)/Season 01/The Expanse S01E03.strm');
});

// ── TorBox usenet/webdl use their own id namespaces, so v0.1 skips them ──
test('torbox usenet and web downloads are skipped, not keyed as torrents', () => {
  const item = { source: 'usenet', id: 55, name: 'Film 2024', files: [{ id: 1, name: 'Film.2024.1080p.mkv', size: 8e9 }] };
  const meta = { ...movieMeta([{ id: 1, name: 'x.mkv', size: 1e9 }]), torboxItems: [{ item, season: null, episode: null }] };
  const { plan, skipped } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/x', metas: [meta] });
  assert.equal(plan.items.length, 0);
  assert.equal(skipped, 1);
});

// ── Posters: our own ERDB proxy (setup token only), never the ERDB key ──
test('an erdb setup gets proxied posters and the erdb key never appears', () => {
  const { plan } = buildPlan({
    provider: 'torbox', baseUrl: 'https://l.uk/abc.def', erdbToken: 'ERDBSECRET',
    metas: [movieMeta([{ id: 2, name: 'The.Matrix.2160p.mkv', size: 18e9 }])],
  });
  assert.equal(plan.items[0].poster, 'https://l.uk/abc.def/erdb/poster/tmdb:movie:603');
  assert.equal(JSON.stringify(plan).includes('ERDBSECRET'), false);
});

test('an episode carries its real title', () => {
  const meta = {
    id: 'tt3230854', tmdbId: 63639, imdbId: 'tt3230854', name: 'The Expanse', year: 2015,
    catalogType: 'series', poster: 'https://img/p.jpg', season: 1, episode: 3,
    entity_key: 'series:63639', episodeTitle: 'Remember the Cant',
    torboxItems: [{
      item: {
        source: 'torrent', id: 77, name: 'The Expanse S01 2160p',
        files: [{ id: 2, name: 'The.Expanse.S01E03.mkv', size: 3e9 }],
      },
      season: 1, episode: 3,
    }],
  };
  const { plan } = buildPlan({ provider: 'torbox', baseUrl: 'https://l.uk/abc.def', metas: [meta] });
  const episode = plan.items.find((i: any) => i.kind === 'episode');
  assert.equal(episode.episodeTitle, 'Remember the Cant');
});

test('the row the store joins carries its episode title into the meta', () => {
  const { rowToMeta } = require('../src/library/catalog.ts');
  const meta = rowToMeta({
    match_meta: { name: 'The Expanse', catalogType: 'series', tmdbId: 63639, season: 1, episode: 3 },
    tmdb_id: 63639, media_type: 'series', raw: { id: 1 },
    episode_title: 'Remember the Cant',
  });
  assert.equal(meta.episodeTitle, 'Remember the Cant');
});
