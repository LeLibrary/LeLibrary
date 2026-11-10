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
