import { describe, expect, it } from 'vitest';
import { hubCollection, withHubExtras, HUB_COLLECTION_ID, type CollectionDoc } from '@/features/setup/shared/collection-doc';
import { applySavedConfig } from '@/features/setup/shared/saved-config';

const oldHub = (): CollectionDoc => {
  const hub = hubCollection('rd', 'https://example.test');
  return { ...hub, folders: hub.folders.slice(0, 2) };
};

describe('an older Hub shows its newer folders', () => {
  it('adds New Releases, 4K, HDR and Genres on the Movies folder prefix, once', () => {
    const upgraded = withHubExtras(oldHub(), 'https://example.test');
    expect(upgraded.folders.map((f) => f.id)).toEqual([
      'folder-lelibrary-hub-movies', 'folder-lelibrary-hub-shows', 'folder-lelibrary-hub-new',
      'folder-lelibrary-hub-4k', 'folder-lelibrary-hub-hdr', 'folder-lelibrary-hub-genres',
    ]);
    expect(upgraded.folders[2]!.catalogSources.map((s) => s.catalogId)).toEqual(['rd-movies-new', 'rd-series-new']);
    expect(upgraded.folders[5]!.catalogSources.map((s) => s.catalogId)).toEqual(['rd-movies-genres', 'rd-series-genres']);
    expect(withHubExtras(upgraded, 'https://example.test')).toBe(upgraded);
  });

  it('a 5.9 Hub gets New Releases right after Shows; its own folders keep their places', () => {
    const hub = hubCollection('rd', 'https://example.test');
    const mine = { ...hub.folders[0]!, id: 'folder-mine', title: 'Mine' };
    const saved = { ...hub, folders: [...hub.folders.filter((f) => f.id !== 'folder-lelibrary-hub-new'), mine] };
    expect(withHubExtras(saved, 'https://example.test').folders.map((f) => f.id)).toEqual([
      'folder-lelibrary-hub-movies', 'folder-lelibrary-hub-shows', 'folder-lelibrary-hub-new',
      'folder-lelibrary-hub-4k', 'folder-lelibrary-hub-hdr', 'folder-lelibrary-hub-genres', 'folder-mine',
    ]);
  });

  it('keeps the saved folders exactly and leaves other collections alone', () => {
    const hub = oldHub();
    hub.folders[0]!.title = 'Films';
    expect(withHubExtras(hub, '').folders[0]!.title).toBe('Films');
    const other = { id: 'collection-x', title: 'X', folders: [] } as unknown as CollectionDoc;
    expect(withHubExtras(other, '')).toBe(other);
  });

  it('a saved setup opens with the full Hub, so the editor shows what a push sends', () => {
    const drafts = applySavedConfig({ collections: [oldHub()] });
    const hub = drafts.collections.find((c) => c.id === HUB_COLLECTION_ID)!;
    expect(hub.folders.some((f) => f.id === 'folder-lelibrary-hub-genres')).toBe(true);
  });
});
