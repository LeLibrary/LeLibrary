import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The Home rows page: no network, every API call never resolves.
const api = vi.hoisted(() => ({
  get: vi.fn(() => new Promise(() => {})),
  post: vi.fn(() => new Promise(() => {})), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
}));
vi.mock('@/api/client', () => ({ apiClient: api }));

const { HomeRowsSection } = await import('@/features/setup/full/HomeRowsSection');
type HomeRowDoc = import('@/features/setup/shared/collection-doc').HomeRowDoc;

function importedRow(id: string, title: string, catalogId: string, extra: { addonName?: string } = {}): HomeRowDoc {
  return {
    id,
    title,
    source: {
      kind: 'catalog', id: catalogId, catalogId, type: 'movie',
      addonId: 'com.mdblist.trending-movies', addonUrl: 'https://mdblist.com/addon/x/manifest.json',
      ...extra,
    },
    enabled: true, limit: 20, order: 0, customTitle: false,
  };
}

function render(rows: HomeRowDoc[]): string {
  return renderToStaticMarkup(
    <HomeRowsSection rows={rows} onChange={() => {}} platform="nuvio" prefix="torbox" />,
  );
}

describe('the Home rows page names imported rows', () => {
  it('shows the addon name saved at import', () => {
    const html = render([importedRow('row-1', 'Trending Movies', 'trending-movies-movie', { addonName: 'MDBList' })]);
    expect(html).toContain('Trending Movies');
    expect(html).toContain('>MDBList<');
    expect(html).not.toContain('com.mdblist.trending-movies');
  });

  it('falls back to the addon site for a row imported before names were saved', () => {
    const html = render([importedRow('row-2', 'Trending Shows', 'trakt-s-trending-shows-series')]);
    expect(html).toContain('>mdblist.com<');
    expect(html).not.toContain('com.mdblist.trending-movies');
  });
});
