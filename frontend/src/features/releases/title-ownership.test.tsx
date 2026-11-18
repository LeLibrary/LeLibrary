import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@/i18n';

// What the Releases title page says about a setup's library (v6.1). The hooks
// are stubbed so the exact wording can be asserted: this is the line that must
// never read as "you have it" when seasons are missing.

type Owned = {
  mediaType: 'movie' | 'series'; tmdbId: number; owned: boolean;
  seasons: { season: number; owned: number; total: number | null; pack?: boolean }[];
};
let stubOwned: Owned | null = {
  mediaType: 'series',
  tmdbId: 4656,
  owned: true,
  seasons: [{ season: 34, owned: 17, total: 52 }],
};

vi.mock('@/features/releases/favourites-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/releases/favourites-link')>()),
  useFavouritesLink: () => ({ data: { linked: true }, isError: false }),
  useOwned: () => stubOwned,
  useFavourites: () => ({ data: { items: [] } }),
  useToggleFavourite: () => ({ mutate: () => undefined, isPending: false }),
}));

const { TitleOwnership } = await import('@/features/releases/TitleOwnership');

beforeAll(async () => { await i18n.loadNamespaces('site'); });

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('ownership on a title page', () => {
  it('says how many seasons they hold and names the ones they do not', () => {
    const html = render(
      <TitleOwnership mediaType="series" tmdbId={4656} title="A show" numberOfSeasons={34} />,
    );
    expect(html).toContain('You have 1 of 34 seasons');
    expect(html).toContain('S34 has 17 of 52 episodes');
    expect(html).toContain('Not in your library: S1-S33');
    // Nothing is complete, so no complete line at all.
    expect(html).not.toContain('Complete:');
    // And the star is offered, since the library does hold it.
    expect(html).toContain('Add to favourites');
  });

  it('says nothing about seasons for a film it does not hold', () => {
    stubOwned = { mediaType: 'movie', tmdbId: 603, owned: false, seasons: [] };
    const html = render(<TitleOwnership mediaType="movie" tmdbId={603} title="A film" numberOfSeasons={null} />);
    expect(html).toContain('Not in your library');
    expect(html).not.toContain('Complete:');
    stubOwned = { mediaType: 'series', tmdbId: 4656, owned: true, seasons: [{ season: 34, owned: 17, total: 52 }] };
  });
});
