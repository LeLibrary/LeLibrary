import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Watch history (v6): the card's visibility, its defaults (never saved),
// the shelf, the edit save and the Simkl reconnect note. No network.
const api = vi.hoisted(() => ({
  get: vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})),
  post: vi.fn(() => new Promise(() => {})), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
}));
vi.mock('@/api/client', () => ({ apiClient: api }));

const wh = await import('@/features/setup/shared/watch-history');
const { WatchHistorySection, historyAvailabilityFrom, historyRowsOn } = await import('@/features/setup/shared/WatchHistorySection');
const { ConnectedAccounts } = await import('@/features/setup/shared/ApiKeysSection');
const { userListBrowserRows } = await import('@/features/setup/shared/collection-doc');
const { userListServicesFrom } = await import('@/features/setup/shared/user-lists');
type WatchlistConnections = import('@/features/setup/shared/connected-accounts').WatchlistConnections;
type HistoryAvailability = import('@/features/setup/shared/watch-history').HistoryAvailability;

const NONE: HistoryAvailability = { nuvio: false, simkl: false, mdblist: false, anilist: false };
const noop = () => undefined;

describe('watch history settings', () => {
  it('defaults are never saved; only changes are', () => {
    expect(wh.watchHistoryForConfig(wh.DEFAULT_WATCH_HISTORY)).toBeNull();
    expect(wh.watchHistoryForConfig(wh.cleanWatchHistory({}))).toBeNull();
    const changed = wh.cleanWatchHistory({ hideWatched: true, sources: { anilist: { sync: true } } });
    expect(wh.watchHistoryForConfig(changed)).toEqual({ sources: { anilist: { sync: true } }, hideWatched: true });
    expect(wh.DEFAULT_WATCH_HISTORY.sources.mdblist.history).toBe(false);
    expect(wh.DEFAULT_WATCH_HISTORY.hideWatched).toBe(false);
  });

  it('summary names what is read, copied and hidden', () => {
    const available = { ...NONE, nuvio: true, simkl: true };
    expect(wh.watchHistorySummary(wh.DEFAULT_WATCH_HISTORY, available)).toEqual(['History from Nuvio, Simkl']);
    const on = wh.cleanWatchHistory({ hideWatched: true, sources: { simkl: { sync: true } } });
    expect(wh.watchHistorySummary(on, available)).toEqual(['History from Nuvio, Simkl', 'Copying to Simkl', 'Hiding watched']);
  });
});

describe('the Watch history card', () => {
  const render = (available: HistoryAvailability, value = wh.DEFAULT_WATCH_HISTORY) => renderToStaticMarkup(
    <WatchHistorySection value={value} onChange={noop} available={available} />,
  );

  it('is hidden without any history source', () => {
    expect(render(NONE)).toBe('');
  });

  it('lists only the sources the setup has; MDBList only with a key', () => {
    const html = render({ ...NONE, nuvio: true });
    expect(html).toContain('Watch history');
    expect(html).toContain('data-source="nuvio"');
    expect(html).not.toContain('data-source="mdblist"');
    expect(html).toContain('Hide watched');
    expect(html).toContain('Live scrobbling is done by Nuvio itself');
    expect(render({ ...NONE, nuvio: true, mdblist: true })).toContain('data-source="mdblist"');
  });

  it('Nuvio has no Sync; the others need the Nuvio login to copy', () => {
    const html = render({ ...NONE, simkl: true });
    expect(html).toContain('data-source="simkl"');
    expect(html).toContain('Needs your Nuvio login on this setup.');
    expect(html).toMatch(/disabled=""/);
    const withNuvio = render({ ...NONE, nuvio: true, simkl: true });
    expect(withNuvio).not.toContain('Needs your Nuvio login');
  });

  it('availability: a reconnect-needed Simkl does not count; rows follow the History switches', () => {
    expect(historyAvailabilityFrom({ nuvioLogin: false, simkl: true, simklReconnect: true, anilist: false, mdblist: false }).simkl).toBe(false);
    const available = historyAvailabilityFrom({ nuvioLogin: true, simkl: false, anilist: false, mdblist: true });
    expect(historyRowsOn(wh.DEFAULT_WATCH_HISTORY, available)).toBe(true);
    expect(historyRowsOn(wh.cleanWatchHistory({ sources: { nuvio: { history: false } } }), available)).toBe(false); // MDBList is off by default
    expect(historyRowsOn(wh.DEFAULT_WATCH_HISTORY, NONE)).toBe(false);
  });

  it('the Watch history shelf holds Continue Watching and Up Next, only when on', () => {
    expect(userListBrowserRows({ simkl: false, mdblist: false, anilist: false, history: false })).toEqual([]);
    const rows = userListBrowserRows({ simkl: false, mdblist: false, anilist: false, history: true });
    expect(rows.map((row) => row.catalogId)).toEqual([
      'lelibrary-user-history-continue-movie', 'lelibrary-user-history-continue-series', 'lelibrary-user-history-upnext-series',
    ]);
    expect(new Set(rows.map((row) => row.category))).toEqual(new Set(['Watch history']));
    expect(userListServicesFrom({ history: true }, null).history).toBe(true);
  });
});

describe('Simkl V1 connections', () => {
  function connections(status: Record<string, unknown>): WatchlistConnections {
    return {
      precreation: false,
      config: { simkl: true, trakt: true, anilist: true, traktLegacy: true },
      status: status as never,
      connected: (provider) => provider === 'simkl',
      linked: (provider) => provider === 'simkl',
      identity: () => 'neo',
      configured: () => true,
      canConnect: true,
      connect: async () => {},
      disconnect: async () => {},
    };
  }

  it('a legacy connection shows the gentle reconnect note; a V2 one does not', () => {
    const legacy = renderToStaticMarkup(<ConnectedAccounts defaultOpen="simkl" connections={connections({ simkl: { connected: true, configured: true, legacy: true }, trakt: { connected: false, configured: true } })} />);
    expect(legacy).toContain('Reconnect Simkl to keep it working after 2027.');
    const broken = renderToStaticMarkup(<ConnectedAccounts defaultOpen="simkl" connections={connections({ simkl: { connected: true, configured: true, legacy: true, reconnect: true }, trakt: { connected: false, configured: true } })} />);
    expect(broken).toContain('Disconnect and connect Simkl again');
    const fresh = renderToStaticMarkup(<ConnectedAccounts defaultOpen="simkl" connections={connections({ simkl: { connected: true, configured: true }, trakt: { connected: false, configured: true } })} />);
    expect(fresh).not.toContain('data-simkl-legacy');
  });
});
