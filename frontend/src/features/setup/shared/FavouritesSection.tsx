import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { fetchLibraryItems, type LibraryItem } from '@/features/setup/library/library-api';
import {
  addFavourite, clearFavourites, createPairCode, favouriteKey, fetchFavourites, fetchPairings,
  removeFavourite, revokePairing,
  type FavouriteItem, type FavouriteMediaType, type FavouritesPairing,
} from '@/features/setup/favourites/favourites-api';

// Favourites (v6.1): their own picks, from their own library.
//
// The list lives on the setup (server: setup/favourites-store.ts) and the Hub's
// Favourites folder reads it through the library, so a pick shows exactly what
// they own. This panel only needs the edit token the page already holds: no
// extra connection, and nothing here is shared with anyone else.
//
// Search runs over the setup's own matched library, so a title can only be
// starred once the library actually holds it. That is deliberate: a favourite
// is a bookmark of something they have, never a wishlist.

type Candidate = { mediaType: FavouriteMediaType; tmdbId: number; title: string; year: string | null; poster: string | null };

const SEARCH_DEBOUNCE_MS = 300;

// One line per title however many files or episodes the library holds it in.
function candidatesFrom(items: LibraryItem[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of items) {
    const tmdbId = Number(item.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) continue;
    const mediaType: FavouriteMediaType = item.mediaType === 'movie' ? 'movie' : 'series';
    const key = favouriteKey(mediaType, tmdbId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      mediaType, tmdbId,
      title: item.title || item.name || '',
      year: item.year || null,
      poster: item.poster || null,
    });
  }
  return out;
}

function kindLabel(mediaType: FavouriteMediaType): string {
  return mediaType === 'movie' ? 'Film' : 'Show';
}

function Poster({ poster }: { poster: string | null }) {
  if (!poster) return <span className="fav-poster fav-poster-empty" aria-hidden="true" />;
  return <img className="fav-poster" src={poster} alt="" loading="lazy" decoding="async" />;
}

export function FavouritesSection({ uuid, editToken, locked = false }: {
  uuid: string | null;
  editToken: string | null;
  locked?: boolean;
}) {
  const [items, setItems] = useState<FavouriteItem[]>([]);
  const [limit, setLimit] = useState(300);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pairings, setPairings] = useState<FavouritesPairing[]>([]);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRun = useRef(0);

  const ready = Boolean(uuid && editToken) && !locked;
  const starred = useMemo(() => new Set(items.map((item) => favouriteKey(item.mediaType, item.tmdbId))), [items]);

  useEffect(() => {
    if (!ready || !uuid || !editToken) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      fetchFavourites(uuid, editToken),
      fetchPairings(uuid, editToken).catch(() => ({ pairings: [] as FavouritesPairing[] })),
    ])
      .then(([payload, linked]) => {
        if (cancelled) return;
        setItems(payload.items);
        setLimit(payload.limit);
        setPairings(linked.pairings);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Your favourites could not be loaded.');
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [ready, uuid, editToken]);

  // Search their own library, debounced. Nothing is stored until they star it.
  useEffect(() => {
    if (!ready || !uuid || !editToken) return;
    const text = query.trim();
    if (text.length < 2) { setResults([]); setSearching(false); return; }
    const run = ++searchRun.current;
    setSearching(true);
    const timer = setTimeout(() => {
      fetchLibraryItems(uuid, editToken, { view: 'matched', q: text, offset: 0 })
        .then((payload) => { if (run === searchRun.current) setResults(candidatesFrom(payload.items).slice(0, 24)); })
        .catch(() => { if (run === searchRun.current) setResults([]); })
        .finally(() => { if (run === searchRun.current) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ready, uuid, editToken]);

  async function star(candidate: Candidate) {
    if (!ready || !uuid || !editToken) return;
    const key = favouriteKey(candidate.mediaType, candidate.tmdbId);
    setBusy(key); setError(null);
    try {
      await addFavourite(uuid, editToken, candidate.mediaType, candidate.tmdbId);
      const payload = await fetchFavourites(uuid, editToken);
      setItems(payload.items);
      setLimit(payload.limit);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'That favourite could not be saved.');
    } finally { setBusy(null); }
  }

  async function unstar(item: { mediaType: FavouriteMediaType; tmdbId: number }) {
    if (!ready || !uuid || !editToken) return;
    const key = favouriteKey(item.mediaType, item.tmdbId);
    setBusy(key); setError(null);
    try {
      await removeFavourite(uuid, editToken, item.mediaType, item.tmdbId);
      setItems((current) => current.filter((entry) => favouriteKey(entry.mediaType, entry.tmdbId) !== key));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'That favourite could not be removed.');
    } finally { setBusy(null); }
  }

  async function makeCode() {
    if (!ready || !uuid || !editToken) return;
    setError(null);
    try {
      const made = await createPairCode(uuid, editToken);
      setPairCode(made.code);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'A code could not be made.');
    }
  }

  async function cutOff(pairingId: string) {
    if (!ready || !uuid || !editToken) return;
    setError(null);
    try {
      await revokePairing(uuid, editToken, pairingId);
      setPairings((current) => current.filter((entry) => entry.id !== pairingId));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'That browser could not be cut off.');
    }
  }

  async function clearAll() {
    if (!ready || !uuid || !editToken) return;
    if (!confirmClear) { setConfirmClear(true); return; }
    setError(null);
    try {
      await clearFavourites(uuid, editToken);
      setItems([]);
      setConfirmClear(false);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Your favourites could not be cleared.');
      setConfirmClear(false);
    }
  }

  if (!uuid || !editToken) {
    return (
      <p className="setup-hint">
        Favourites stay with this setup. Create or open a saved setup to pick some.
      </p>
    );
  }

  return (
    <>
      <p className="setup-hint">
        Picked titles appear in the Hub's Favourites folder. Only titles you actually have are shown.
      </p>
      {error && <p className="setup-error">{error}</p>}
      {items.length > 0 && (
        <ul className="fav-list">
          {items.map((item) => {
            const key = favouriteKey(item.mediaType, item.tmdbId);
            return (
              <li key={key} className="fav-row">
                <Poster poster={item.poster} />
                <span className="fav-meta">
                  <strong>{item.title || 'Untitled'}</strong>
                  <small>{[item.year, item.mediaType === 'movie' ? 'Film' : 'Show'].filter(Boolean).join(' · ')}</small>
                </span>
                <button
                  type="button" className="btn-ghost fav-remove"
                  disabled={locked || busy === key}
                  onClick={() => { void unstar(item); }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {loaded && items.length === 0 && (
        <p className="setup-hint">Nothing picked yet. Search your library below to add something.</p>
      )}
      <label className="setup-field">
        <span>Search your library</span>
        <input
          type="search" autoComplete="off" placeholder="A film or show you own"
          value={query} onChange={(event) => setQuery(event.target.value)}
          disabled={locked}
        />
      </label>
      {searching && <p className="setup-hint">Searching...</p>}
      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="setup-hint">Nothing in your library matches that.</p>
      )}
      {results.length > 0 && (
        <ul className="fav-list">
          {results.map((candidate) => {
            const key = favouriteKey(candidate.mediaType, candidate.tmdbId);
            const already = starred.has(key);
            return (
              <li key={key} className="fav-row">
                <Poster poster={candidate.poster} />
                <span className="fav-meta">
                  <strong>{candidate.title || 'Untitled'}</strong>
                  <small>{[candidate.year, candidate.mediaType === 'movie' ? 'Film' : 'Show'].filter(Boolean).join(' · ')}</small>
                </span>
                <button
                  type="button" className="btn-ghost fav-star"
                  disabled={locked || already || busy === key || items.length >= limit}
                  onClick={() => { void star(candidate); }}
                >
                  {already ? 'Picked' : 'Pick'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="qs-sub"><strong>Releases page</strong><span>Link a browser to this setup</span></h3>
      <p className="setup-hint">
        Make a code, then type it on the Releases page. That browser can then keep this list and show
        what you already hold. It never gets your install link, and Unlink stops it from here.
      </p>
      <div className="fav-pair-actions">
        <button type="button" className="btn-ghost" disabled={locked} onClick={() => { void makeCode(); }}>
          Connect the releases page
        </button>
        {pairCode && <code className="fav-pair-code">{pairCode}</code>}
      </div>
      {pairCode && (
        <p className="setup-hint">Give this code to the Releases page. It works once, for ten minutes.</p>
      )}
      {pairings.length === 0 ? (
        <p className="setup-hint">No browsers are linked right now.</p>
      ) : (
        <ul className="fav-list">
          {pairings.map((entry) => (
            <li key={entry.id} className="fav-row">
              <span className="fav-pair-badge" aria-hidden="true">🔗</span>
              <span className="fav-meta">
                <strong>{entry.label || 'Browser'}</strong>
                <small>{new Date(entry.lastUsedAt || entry.createdAt).toLocaleDateString()}</small>
              </span>
              <button
                type="button" className="btn-ghost fav-remove"
                disabled={locked}
                onClick={() => { void cutOff(entry.id); }}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <button type="button" className="btn-danger" disabled={locked} onClick={() => { void clearAll(); }}>
          {confirmClear ? 'Clear all? Click again to confirm.' : 'Clear all favourites'}
        </button>
      )}
    </>
  );
}
