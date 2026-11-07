import { Accordion } from '@/features/setup/shared/Accordion';
import {
  visibleHistorySources,
  watchHistorySummary,
  type HistoryAvailability,
  type HistorySourceId,
  type SyncTargetId,
  type WatchHistoryDraft,
} from '@/features/setup/shared/watch-history';

// Watch history (v6), under Integrations on Settle In and Move In: which
// services LeLibrary reads what you watched from, which ones get a copy of
// Nuvio's finished history, and Hide watched. Shown only when the setup has
// at least one source (a Nuvio login, Simkl, AniList, or an MDBList key).

const SOURCE_COPY: Record<HistorySourceId, { name: string; hint: string }> = {
  nuvio: { name: 'Nuvio', hint: 'Everything you watch in Nuvio, on every device and with any stream source. Read from the profile this setup pushes to.' },
  simkl: { name: 'Simkl', hint: 'Your Simkl completed and watching lists.' },
  mdblist: { name: 'MDBList', hint: 'Uses your own MDBList daily allowance, so it is off until you switch it on. Read only when something changed.' },
  anilist: { name: 'AniList', hint: 'Your AniList completed and watching anime.' },
};

const SYNC_COPY: Record<SyncTargetId, string> = {
  simkl: 'Copy what you finish in Nuvio to Simkl.',
  mdblist: 'Copy what you finish in Nuvio to MDBList.',
  anilist: 'Copy anime episodes you finish in Nuvio to your AniList progress. Titles AniList cannot match exactly are skipped.',
};

// Which history sources the page knows the setup has. Nuvio: a login made
// on this page for a Nuvio setup, or the saved one (edit). Simkl: connected
// and still usable. Pure for unit tests.
export function historyAvailabilityFrom(input: {
  nuvioLogin: boolean;
  simkl: boolean;
  simklReconnect?: boolean | undefined;
  anilist: boolean;
  mdblist: boolean;
}): HistoryAvailability {
  return {
    nuvio: input.nuvioLogin,
    simkl: input.simkl && input.simklReconnect !== true,
    mdblist: input.mdblist,
    anilist: input.anilist,
  };
}

// The Continue Watching / Up Next shelves show while a source is read.
export function historyRowsOn(value: WatchHistoryDraft, available: HistoryAvailability): boolean {
  return visibleHistorySources(available).some((name) => value.sources[name].history);
}

export function WatchHistorySection({ value, onChange, available, simklLegacy }: {
  value: WatchHistoryDraft;
  onChange: (next: WatchHistoryDraft) => void;
  available: HistoryAvailability;
  // A Simkl connection from the old V1 app: copying needs a reconnect.
  simklLegacy?: boolean | undefined;
}) {
  const visible = visibleHistorySources(available);
  if (!visible.length) return null;
  const setSource = (name: HistorySourceId, field: 'history' | 'sync', on: boolean) => {
    onChange({ ...value, sources: { ...value.sources, [name]: { ...value.sources[name], [field]: on } } });
  };
  return (
    <Accordion title="Watch history" icon="🕘" summary={watchHistorySummary(value, available)}>
      <p className="setup-hint qs-note">Optional. Read what you have watched to fill the Continue Watching and Up Next rows (add them in Home rows) and, if you like, hide what you have already seen.</p>
      <div className="wh-sources">
        {visible.map((name) => {
          const copy = SOURCE_COPY[name];
          const canSync = name !== 'nuvio';
          return (
            <div className="wh-source" key={name} data-source={name}>
              <h4 data-i18n-preserve>{copy.name}</h4>
              <label className="switch-row">
                <span><strong>History</strong><small>{copy.hint}</small></span>
                <input type="checkbox" checked={value.sources[name].history} onChange={(event) => setSource(name, 'history', event.target.checked)} />
                <i aria-hidden="true" />
              </label>
              {canSync && (
                <label className="switch-row">
                  <span>
                    <strong>Sync</strong>
                    <small>{SYNC_COPY[name as SyncTargetId]}</small>
                    {!available.nuvio && <small>Needs your Nuvio login on this setup.</small>}
                    {available.nuvio && name === 'simkl' && simklLegacy && <small>Reconnect Simkl first: copying needs the new Simkl sign-in.</small>}
                  </span>
                  <input
                    type="checkbox"
                    checked={(value.sources[name] as { sync: boolean }).sync}
                    disabled={!available.nuvio}
                    onChange={(event) => setSource(name, 'sync', event.target.checked)}
                  />
                  <i aria-hidden="true" />
                </label>
              )}
            </div>
          );
        })}
      </div>
      <label className="switch-row">
        <span><strong>Hide watched</strong><small>Leave out films you have watched and shows you are caught up on, in your library rows, discovery rows, Hub shelves and collections. Search and your own lists still show everything.</small></span>
        <input type="checkbox" checked={value.hideWatched} onChange={(event) => onChange({ ...value, hideWatched: event.target.checked })} />
        <i aria-hidden="true" />
      </label>
      <p className="setup-hint pc-note">Live scrobbling is done by Nuvio itself: sign in to Simkl, MDBList or Trakt inside the Nuvio app. LeLibrary never scrobbles, so nothing is marked twice. Sync only copies from the moment you switch it on, about every 30 minutes.</p>
    </Accordion>
  );
}
