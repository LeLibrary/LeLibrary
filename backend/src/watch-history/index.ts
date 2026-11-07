'use strict';
// Watch history (v6): entry points for the catalogue route.
//
// - hideWatchedFilter: Hide watched on one catalogue request (library rows,
//   discovery and curated rows, Hub shelves, Movie Collections), applied to
//   the response after every shared cache read.
// - historyRowItems: the Continue Watching / Up Next rows.
// - noteActive: a catalogue request marks the setup in use (sync schedule).
import type { WatchHistoryConfigApi } from './config.ts';
import type { WatchHistoryReaderApi, ReaderDeps } from './reader.ts';
import type { WatchHistorySyncApi } from './sync.ts';
import type { ListItem } from '../user-lists/metas.ts';

const cfg = require('./config.ts') as WatchHistoryConfigApi;
const reader = require('./reader.ts') as WatchHistoryReaderApi;
const sync = require('./sync.ts') as WatchHistorySyncApi;

type Config = Record<string, unknown>;

// Rows Hide watched never touches: search answers what was asked for, and
// personal rows (Completed, Continue Watching...) are about your history.
function hideWatchedApplies(catalogId: unknown): boolean {
  const id = String(catalogId || '');
  if (!id) return false;
  if (/^lelibrary-search-/.test(id)) return false;
  if (/^lelibrary-user-/.test(id) || /^torbox-watchlist-/.test(id)) return false;
  if (/^custom-stream-/.test(id)) return false;
  return true;
}

// How long the first request of a setup waits for its history before
// answering unfiltered (the build carries on in the background).
const HIDE_WAIT_MS = 1500;
const ROW_WAIT_MS = 8000;

// A filter for this request's metas, or null (Hide watched off, a row it
// does not apply to, or no history yet).
async function hideWatchedFilter(config: Config, catalogId: unknown, deps: ReaderDeps = {}): Promise<((metas: unknown[]) => unknown[]) | null> {
  if (!hideWatchedApplies(catalogId)) return null;
  const effective = cfg.effectiveWatchHistory(config);
  if (!effective.hideWatched) return null;
  const state = await reader.historyFor(config, { waitMs: HIDE_WAIT_MS }, deps).catch(() => null);
  if (!state || (!state.watched.length && !state.caughtUp.length)) return null;
  return (metas) => reader.filterWatched(metas, state);
}

async function historyRowItems(config: Config, list: string, type: 'movie' | 'series', deps: ReaderDeps = {}): Promise<ListItem[]> {
  const state = await reader.historyFor(config, { waitMs: ROW_WAIT_MS }, deps).catch(() => null);
  return reader.historyRowItems(state, list, type);
}

function noteActive(config: Config): void {
  sync.noteActive(config).catch(() => {});
}

export interface WatchHistoryApi {
  hideWatchedApplies: typeof hideWatchedApplies;
  hideWatchedFilter: typeof hideWatchedFilter;
  historyRowItems: typeof historyRowItems;
  noteActive: typeof noteActive;
  effectiveWatchHistory: WatchHistoryConfigApi['effectiveWatchHistory'];
  compactWatchHistory: WatchHistoryConfigApi['compactWatchHistory'];
}

module.exports = {
  hideWatchedApplies, hideWatchedFilter, historyRowItems, noteActive,
  effectiveWatchHistory: cfg.effectiveWatchHistory,
  compactWatchHistory: cfg.compactWatchHistory,
} satisfies WatchHistoryApi;
