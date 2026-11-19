// @ts-nocheck
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allowPush,
  savedNuvioAccessToken,
  savedNuvioRefreshToken,
  isLeLibraryCollection,
  nuvioHomeKey,
  resolveNuvioProfile,
} = require('../src/setup/push.ts');

test('nuvio pushes are capped per setup', () => {
  const key = `test-uuid-${Date.now()}`;
  assert.equal(allowPush(key), true);
  assert.equal(allowPush(key), true);
  assert.equal(allowPush(key), true);
  assert.equal(allowPush(key), true);
  assert.equal(allowPush(key), false);
  assert.equal(allowPush(`other-${Date.now()}`), true);
});

test('nuvio token readers accept the canonical and legacy shapes', () => {
  assert.equal(savedNuvioAccessToken({ nuvioToken: 'abc' }), 'abc');
  assert.equal(savedNuvioAccessToken({ access_token: 'legacy' }), 'legacy');
  assert.equal(savedNuvioAccessToken(null), '');
  assert.equal(savedNuvioAccessToken({}), '');
  assert.equal(savedNuvioRefreshToken({ nuvioRefresh: 'r1' }), 'r1');
  assert.equal(savedNuvioRefreshToken({ refresh_token: 'r2' }), 'r2');
  assert.equal(savedNuvioRefreshToken({}), '');
});

test('lelibrary collections are recognised for cleanup', () => {
  assert.equal(isLeLibraryCollection({ id: 'collection-lelibrary-franchises' }), true);
  assert.equal(isLeLibraryCollection({ id: 'collection-lelibrary-pack-x' }), true);
  assert.equal(isLeLibraryCollection({ id: 'lelibrary-special' }), true);
  assert.equal(isLeLibraryCollection({ id: 'pack-lelibrary-special-1' }), true);
  assert.equal(isLeLibraryCollection({ title: 'LeLibrary Special' }), true);
  assert.equal(isLeLibraryCollection({ id: 'something-else', title: 'Other' }), false);
  assert.equal(isLeLibraryCollection(null), false);
});

test('nuvio home keys are underscore-delimited', () => {
  assert.equal(nuvioHomeKey('community.lelibrary', 'movie', 'lib-x'), 'community.lelibrary_movie_lib-x');
});

test('a re-read of the profile finds each Home entry by the same key', () => {
  const { homeItemMapKey } = require('../src/setup/push.ts');
  assert.equal(homeItemMapKey({ addon_id: 'com.mdblist.trending-movies', type: 'movie', catalog_id: 'trending-movies-movie' }),
    'com.mdblist.trending-movies_movie_trending-movies-movie');
  // Collections are keyed by id, whatever catalogue fields an older push left.
  assert.equal(homeItemMapKey({ is_collection: true, collection_id: 'collection-lelibrary-hub' }), 'collection_collection-lelibrary-hub');
  assert.equal(homeItemMapKey({ collection_id: 'collection-x', addon_id: '', type: '', catalog_id: '' }), 'collection_collection-x');
});

test('the order a profile holds is read by item order, then list position', () => {
  const { orderedHomeKeys } = require('../src/setup/push.ts');
  const items = [
    { addon_id: 'b', type: 'movie', catalog_id: 'two', order: 2 },
    { addon_id: 'a', type: 'movie', catalog_id: 'one', order: 1 },
    { addon_id: 'c', type: 'movie', catalog_id: 'three', order: 1 },
  ];
  assert.deepEqual(orderedHomeKeys(items), ['a_movie_one', 'c_movie_three', 'b_movie_two']);
});

test('a changed Home order is noticed, other addons between our rows are not', () => {
  const { homeKeysInOrder } = require('../src/setup/push.ts');
  const planned = ['collection_a', 'x_movie_one', 'y_series_two'];
  assert.equal(homeKeysInOrder(planned, planned), true);
  // Another addon's row between ours keeps its place: still our order.
  assert.equal(homeKeysInOrder(planned, ['collection_a', 'other_movie_z', 'x_movie_one', 'y_series_two']), true);
  // A row moved above the collections, or one of ours missing: changed.
  assert.equal(homeKeysInOrder(planned, ['x_movie_one', 'collection_a', 'y_series_two']), false);
  assert.equal(homeKeysInOrder(planned, ['collection_a', 'x_movie_one']), false);
  assert.equal(homeKeysInOrder([], []), true);
});

test('planning the Home order twice changes nothing, so a re-apply is safe', () => {
  const { planNuvioHomeItems } = require('../src/setup/push.ts');
  const manifestId = 'community.lelibrary';
  const manifest = { id: manifestId, catalogs: [{ type: 'movie', id: 'torbox-movies', showInHome: true }] };
  const homeRows = [
    {
      id: 'row-import', title: 'Trending Movies', enabled: true, order: 0, customTitle: false,
      source: { kind: 'catalog', id: 'trending-movies-movie', catalogId: 'trending-movies-movie', type: 'movie', addonId: 'com.mdblist.trending-movies', addonUrl: 'https://mdblist.com/manifest.json' },
    },
    {
      id: 'row-own', title: 'My Movies', enabled: true, order: 1, customTitle: false,
      source: { kind: 'catalog', id: 'torbox-movies', catalogId: 'torbox-movies', type: 'movie', addonId: '', addonUrl: '' },
    },
  ];
  const collections = [{ id: 'collection-lelibrary-hub' }, { id: 'collection-mine' }];
  const once = planNuvioHomeItems({ items: [], manifest, homeRows, collections, franchiseSlot: null });
  const twice = planNuvioHomeItems({ items: once, manifest, homeRows, collections, franchiseSlot: null });
  assert.deepEqual(twice, once);
  // Collections lead, then the imported row, then LeLibrary's own row.
  assert.deepEqual(once.filter((item) => item.enabled !== false).map((item) => (item.is_collection ? `collection_${item.collection_id}` : item.catalog_id)),
    ['collection_collection-lelibrary-hub', 'collection_collection-mine', 'trending-movies-movie', 'torbox-movies']);
});

test('the setup\'s own Home order can put a row above a collection', () => {
  const { planNuvioHomeItems } = require('../src/setup/push.ts');
  const manifest = { id: 'community.lelibrary', catalogs: [{ type: 'movie', id: 'torbox-movies', showInHome: true }] };
  const homeRows = [
    {
      id: 'row-import', title: 'Trending Movies', enabled: true, order: 0, customTitle: false,
      source: { kind: 'catalog', id: 'trending-movies-movie', catalogId: 'trending-movies-movie', type: 'movie', addonId: 'com.mdblist.trending-movies', addonUrl: 'https://mdblist.com/manifest.json' },
    },
    {
      id: 'row-own', title: 'My Movies', enabled: true, order: 1, customTitle: false,
      source: { kind: 'catalog', id: 'torbox-movies', catalogId: 'torbox-movies', type: 'movie', addonId: '', addonUrl: '' },
    },
  ];
  const collections = [{ id: 'collection-lelibrary-hub' }, { id: 'collection-mine' }];
  const key = (item: Record<string, unknown>) => (item['is_collection'] ? `collection_${item['collection_id']}` : String(item['catalog_id']));

  // The person dragged the imported row to the very top in Home layout.
  const items = planNuvioHomeItems({
    items: [],
    manifest,
    homeRows,
    collections,
    franchiseSlot: null,
    homeOrder: ['row-import', 'collection-lelibrary-hub', 'row-own', 'collection-mine'],
  });
  assert.deepEqual(items.map(key), [
    'trending-movies-movie', 'collection_collection-lelibrary-hub', 'torbox-movies', 'collection_collection-mine',
  ]);

  // Arranged again: the order holds, and a second apply changes nothing.
  const again = planNuvioHomeItems({ items, manifest, homeRows, collections, franchiseSlot: null,
    homeOrder: ['row-import', 'collection-lelibrary-hub', 'row-own', 'collection-mine'] });
  assert.deepEqual(again, items);

  // No saved order: collections still lead, exactly as before this change.
  const untouched = planNuvioHomeItems({ items: [], manifest, homeRows, collections, franchiseSlot: null });
  assert.deepEqual(untouched.map(key).slice(0, 2), ['collection_collection-lelibrary-hub', 'collection_collection-mine']);
});

test('a chosen nuvio profile that is gone fails instead of retargeting profile 1', () => {
  const profiles = [
    { profile_index: 1, name: 'Lewis', uses_primary_addons: true },
    { profile_index: 2, name: 'Main2', uses_primary_addons: false },
  ];
  // The reported bug: profile 3 selected, only 1 and 2 exist, push used to
  // quietly go to profile 1.
  const missing = resolveNuvioProfile(profiles, 3);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no longer on the account/);

  // A live choice is honoured, including a profile added after the setup.
  assert.equal(resolveNuvioProfile(profiles, 2).profile.name, 'Main2');
  assert.equal(resolveNuvioProfile(profiles, '2').profile.profile_index, 2);

  // No choice at all stays the documented first-profile default.
  assert.equal(resolveNuvioProfile(profiles, null).profile.profile_index, 1);
  assert.equal(resolveNuvioProfile(profiles, '').profile.profile_index, 1);

  // And nothing to push to is still an error.
  assert.equal(resolveNuvioProfile([], null).ok, false);
  assert.equal(resolveNuvioProfile([], 4).ok, false);
});
