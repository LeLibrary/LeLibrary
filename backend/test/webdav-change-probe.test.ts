// @ts-nocheck
// Fast change detection for a WebDAV library (zurg, a NAS): a new release is
// noticed without walking the release folders again, and an unchanged library is
// answered without reading into a single one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeWebdav } = require('./helpers/fake-webdav.ts');

process.env.WEBDAV_SOURCE = 'on';
process.env.WEBDAV_ALLOW_PRIVATE = 'on';
const webdav = require('../src/providers/webdav.ts');

const GB = 1500;
const TREE = {
  '/Movies/Heat (1995)/Heat.1995.1080p.mkv': GB,
  '/Movies/Léon (1994)/Leon.1994.1080p.mkv': GB,
  '/Shows/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv': GB,
  '/Shows/Breaking Bad/Season 1/Breaking.Bad.S01E02.mkv': GB,
};

// The shallow listing is reused for a few seconds on purpose; tests move the
// clock instead of waiting.
function clock(start = 1_760_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function memoryCache() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

const config = (dav) => ({ webdavUrl: dav.url, webdavUser: 'u', webdavPassword: 'p' });
const releaseListings = (log) => log.filter((r) => r.method === 'PROPFIND' && /\/Movies\/|\/Shows\//.test(r.url) && !/\/Movies\/?$|\/Shows\/?$/.test(r.url));

test('an unchanged library is answered without reading into any release folder', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const cache = memoryCache();
  const time = clock();
  try {
    const first = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    assert.equal(first.length, 3);
    time.advance(30_000);
    dav.log.length = 0;
    const second = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    assert.deepEqual(second.map((i) => i.id), first.map((i) => i.id));
    assert.deepEqual(releaseListings(dav.log), [], 'no release folder was listed again');
    // Only the base and its two containers were listed.
    assert.equal(dav.log.length, 3);
  } finally { await dav.close(); }
});

test('a new release is listed on its own, and shows up straight away', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const cache = memoryCache();
  const time = clock();
  try {
    const first = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    assert.equal(first.length, 3);

    dav.add('/Movies/Heat 2 (2026)/Heat.2.2026.2160p.mkv', GB);
    time.advance(30_000);
    dav.log.length = 0;
    const second = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    assert.deepEqual(second.map((i) => i.name).sort(), ['Breaking Bad Season 1', 'Heat (1995)', 'Heat 2 (2026)', 'Léon (1994)']);
    const listed = releaseListings(dav.log).map((r) => r.url);
    assert.ok(listed.some((url) => /Heat%202|Heat 2/.test(url)), listed.join(' '));
    assert.ok(!listed.some((url) => /Heat%20\(1995\)|Leon/.test(url)), `read only the new release: ${listed.join(' ')}`);
  } finally { await dav.close(); }
});

test('a release removed at the source disappears on the next scan', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const cache = memoryCache();
  const time = clock();
  try {
    await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    dav.remove('/Movies/Léon (1994)/Leon.1994.1080p.mkv');
    dav.remove('/Movies/Léon (1994)/');
    time.advance(30_000);
    const next = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    assert.deepEqual(next.map((i) => i.name).sort(), ['Breaking Bad Season 1', 'Heat (1995)']);
  } finally { await dav.close(); }
});

test('a file added inside an existing release is picked up from its folder moving', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const cache = memoryCache();
  const time = clock();
  try {
    await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    dav.add('/Shows/Breaking Bad/Season 1/Breaking.Bad.S01E03.mkv', GB);
    time.advance(30_000);
    const next = await webdav.listWebdavLibrary(config(dav), { deps: { cache, now: time.now } });
    const show = next.find((i) => i.name === 'Breaking Bad Season 1');
    assert.equal(show.files.length, 3);
  } finally { await dav.close(); }
});

test('the probe answers the same while nothing moves, and changes when something does', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const cache = memoryCache();
  const time = clock();
  try {
    const before = await webdav.probeWebdav(config(dav), { cache, now: time.now });
    assert.ok(before && before.sig);
    const same = await webdav.probeWebdav(config(dav), { cache, now: time.now });
    assert.equal(same.sig, before.sig);

    dav.add('/Movies/Dune (2021)/Dune.2021.2160p.mkv', GB);
    time.advance(30_000);
    const after = await webdav.probeWebdav(config(dav), { cache, now: time.now });
    assert.notEqual(after.sig, before.sig);

    // A removed release moves it again.
    dav.remove('/Movies/Dune (2021)/Dune.2021.2160p.mkv');
    dav.remove('/Movies/Dune (2021)/');
    time.advance(30_000);
    const gone = await webdav.probeWebdav(config(dav), { cache, now: time.now });
    assert.notEqual(gone.sig, after.sig);
  } finally { await dav.close(); }
});

test('the probe is null, not an empty answer, when the server is unreachable', async () => {
  const dav = await createFakeWebdav({ files: TREE });
  const url = dav.url;
  await dav.close();
  const probe = await webdav.probeWebdav({ webdavUrl: url, webdavUser: 'u', webdavPassword: 'p' }, { cache: memoryCache() });
  assert.equal(probe, null);
});

test('a server that mirrors everything into __all__ is read once, not twice', async () => {
  // zurg's layout: real categories plus a __all__ mirror of everything, and
  // server plumbing in other __ folders.
  const dav = await createFakeWebdav({
    files: {
      '/movies/Heat (1995)/Heat.1995.mkv': GB,
      '/shows/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv': GB,
      '/__all__/Heat (1995)/Heat.1995.mkv': GB,
      '/__all__/Breaking Bad/Season 1/Breaking.Bad.S01E01.mkv': GB,
      '/__all__/Unfiled Film (2020)/Unfiled.2020.mkv': GB,
      '/__magic__/Some View/Some.View.mkv': GB,
      '/__unplayable__/Broken/Broken.mkv': GB,
    },
  });
  try {
    const items = await webdav.listWebdavLibrary(config(dav), { deps: { cache: memoryCache(), now: clock().now } });
    const names = items.map((i) => i.name).sort();
    // Heat and Breaking Bad come from their categories; the mirror only adds
    // the release no category has. Plumbing folders contribute nothing.
    assert.deepEqual(names, ['Breaking Bad Season 1', 'Heat (1995)', 'Unfiled Film (2020)']);
    assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'no duplicate titles');
    // The mirror's duplicate of Heat was not read.
    const read = dav.log.filter((r) => r.method === 'PROPFIND').map((r) => decodeURIComponent(r.url));
    assert.ok(read.some((url) => /__all__\/Unfiled/.test(url)), 'the mirror fills in what categories miss');
    assert.ok(!read.some((url) => /__all__\/Heat/.test(url)), 'the mirror does not re-read a release a category has');
    assert.ok(!read.some((url) => /__magic__\/Some 5|__magic__\/Some%20View|__unplayable__/.test(url)), 'plumbing is never read');
  } finally { await dav.close(); }
});
