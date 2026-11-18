import { describe, expect, it } from 'vitest';
import { heldSeasons, type OwnedEntry } from '@/features/releases/favourites-link';

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
    expect(heldSeasons({ mediaType: 'movie', tmdbId: 603, owned: true, seasons: [] })).toEqual({ complete: [], partial: [] });
  });

  it('splits whole seasons from the ones they are part-way through', () => {
    expect(heldSeasons(series([
      { season: 1, owned: 10, total: 10 },
      { season: 2, owned: 10, total: 10 },
      { season: 3, owned: 4, total: 10 },
    ]))).toEqual({ complete: [1, 2], partial: [{ season: 3, owned: 4, total: 10 }] });
  });

  it('counts a season with no known length as partial, and ignores specials', () => {
    expect(heldSeasons(series([
      { season: 0, owned: 3, total: 12 },
      { season: 1, owned: 8, total: null },
    ]))).toEqual({ complete: [], partial: [{ season: 1, owned: 8, total: null }] });
  });

  it('a show with files but no episode rows still counts as owned', () => {
    expect(heldSeasons({ mediaType: 'series', tmdbId: 1396, owned: true, seasons: [] })).toEqual({ complete: [], partial: [] });
  });
});
