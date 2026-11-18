import { describe, expect, it } from 'vitest';
import { heldSeasons, seasonRanges, type OwnedEntry } from '@/features/releases/favourites-link';

// What the Releases page says about a setup's library (v6.1). The wording is
// built from this, so it has to be right: whole seasons, part-watched seasons,
// a title they do not have at all, and a show whose episode counts TMDB has
// not given us.

const series = (seasons: OwnedEntry['seasons']): OwnedEntry => ({ mediaType: 'series', tmdbId: 1396, owned: true, seasons });

describe('ownership on a release page', () => {
  it('says nothing when the setup does not have the title', () => {
    expect(heldSeasons(null)).toBeNull();
    expect(heldSeasons({ mediaType: 'movie', tmdbId: 603, owned: false, seasons: [] })).toBeNull();
  });

  it('a film that is in the library is just owned', () => {
    expect(heldSeasons({ mediaType: 'movie', tmdbId: 603, owned: true, seasons: [] })).toEqual({ complete: [], partial: [], missing: [] });
  });

  it('splits whole seasons from the ones they are part-way through', () => {
    expect(heldSeasons(series([
      { season: 1, owned: 10, total: 10 },
      { season: 2, owned: 10, total: 10 },
      { season: 3, owned: 4, total: 10 },
    ]))).toEqual({ complete: [1, 2], partial: [{ season: 3, owned: 4, total: 10 }], missing: [] });
  });

  it('never calls a season complete on an unknown length (7 of 10 must stay partial)', () => {
    expect(heldSeasons(series([
      { season: 3, owned: 7, total: null },
    ]))).toEqual({ complete: [], partial: [{ season: 3, owned: 7, total: null }], missing: [] });
    // A zero length is "not fetched yet" too, not "a season of no episodes".
    expect(heldSeasons(series([
      { season: 3, owned: 7, total: 0 },
    ]))).toEqual({ complete: [], partial: [{ season: 3, owned: 7, total: 0 }], missing: [] });
    // And the real case: earlier seasons whole, the latest part-way.
    expect(heldSeasons(series([
      { season: 1, owned: 8, total: 8 },
      { season: 2, owned: 10, total: 10 },
      { season: 3, owned: 7, total: 10 },
    ]))).toEqual({ complete: [1, 2], partial: [{ season: 3, owned: 7, total: 10 }], missing: [] });
  });

  it('counts a season with no known length as partial, and ignores specials', () => {
    expect(heldSeasons(series([
      { season: 0, owned: 3, total: 12 },
      { season: 1, owned: 8, total: null },
    ]))).toEqual({ complete: [], partial: [{ season: 1, owned: 8, total: null }], missing: [] });
  });

  it('a show with files but no episode rows still counts as owned', () => {
    expect(heldSeasons({ mediaType: 'series', tmdbId: 1396, owned: true, seasons: [] })).toEqual({ complete: [], partial: [], missing: [] });
  });
});

describe('what is missing, and how the list reads', () => {
  it('names the seasons the show has and the setup does not', () => {
    // The case from dev: a 34-season show, seasons 1-30 held (30 part-way).
    const held = heldSeasons(series([
      { season: 29, owned: 52, total: 52 },
      { season: 30, owned: 7, total: 52 },
    ]), 34);
    expect(held).toEqual({
      complete: [29],
      partial: [{ season: 30, owned: 7, total: 52 }],
      missing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34],
    });
  });

  it('never invents missing seasons without a season count', () => {
    expect(heldSeasons(series([{ season: 1, owned: 8, total: 8 }]))?.missing).toEqual([]);
    expect(heldSeasons(series([{ season: 1, owned: 8, total: 8 }]), 0)?.missing).toEqual([]);
    expect(heldSeasons(series([{ season: 1, owned: 8, total: 8 }]), null)?.missing).toEqual([]);
  });

  it('compresses a long list into ranges', () => {
    expect(seasonRanges([1, 2, 3, 7, 8, 10])).toEqual([
      { from: 1, to: 3 }, { from: 7, to: 8 }, { from: 10, to: 10 },
    ]);
    expect(seasonRanges([])).toEqual([]);
    expect(seasonRanges([5, 1, 2, 2, 0, -1])).toEqual([{ from: 1, to: 2 }, { from: 5, to: 5 }]);
  });
});
