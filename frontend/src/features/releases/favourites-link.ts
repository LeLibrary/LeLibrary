import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

// Linking the Releases page to a setup (v6.1).
//
// No login and no install link: the setup page shows a short code, this page
// sends it, and the server answers with a scoped, revocable cookie that can
// only touch that setup's favourites and ask what the library holds. Every
// call here is same-origin with credentials.

export type FavouriteKind = 'movie' | 'series';

export interface FavouriteEntry {
  mediaType: FavouriteKind;
  tmdbId: number;
  addedAt?: string;
  title: string;
  year: string | null;
  poster: string | null;
}

export interface OwnedEntry {
  mediaType: FavouriteKind;
  tmdbId: number;
  owned: boolean;
  // `pack` marks a season held as one season pack: the whole season, even when
  // its length is unknown.
  seasons: { season: number; owned: number; total: number | null; pack?: boolean }[];
}

const AUTH = { authenticated: true } as const;

export function fetchFavouritesStatus(): Promise<{ linked: boolean }> {
  return apiClient.get<{ linked: boolean }>('/api/favourites/status', AUTH);
}

export function fetchFavourites(): Promise<{ linked: boolean; items: FavouriteEntry[]; limit: number }> {
  return apiClient.get<{ linked: boolean; items: FavouriteEntry[]; limit: number }>('/api/favourites', AUTH);
}

export function pairFavourites(code: string): Promise<{ linked: boolean; items: FavouriteEntry[] }> {
  return apiClient.post<{ linked: boolean; items: FavouriteEntry[] }>('/api/favourites/pair', { code }, AUTH);
}

export function disconnectFavourites(): Promise<{ linked: boolean }> {
  return apiClient.post<{ linked: boolean }>('/api/favourites/disconnect', {}, AUTH);
}

export function setFavourite(entry: { mediaType: FavouriteKind; tmdbId: number; wanted: boolean }): Promise<{ saved: boolean }> {
  return apiClient.post<{ saved: boolean }>('/api/favourites', entry, AUTH);
}

export function fetchOwned(items: { mediaType: FavouriteKind; tmdbId: number }[]): Promise<{ items: OwnedEntry[] }> {
  return apiClient.post<{ items: OwnedEntry[] }>('/api/favourites/owned', { items }, AUTH);
}

export const favouritesKeys = {
  status: ['favourites', 'status'] as const,
  list: ['favourites', 'list'] as const,
  owned: (type: string, id: number) => ['favourites', 'owned', type, id] as const,
};

// Is this browser linked? One shared query for the page and the title panel.
export function useFavouritesLink() {
  return useQuery({
    queryKey: favouritesKeys.status,
    queryFn: fetchFavouritesStatus,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

// The list, only once linked.
export function useFavourites() {
  const link = useFavouritesLink();
  const query = useQuery({
    queryKey: favouritesKeys.list,
    queryFn: fetchFavourites,
    enabled: link.data?.linked === true,
    staleTime: 60 * 1000,
    retry: false,
  });
  return { ...query, linked: link.data?.linked === true, linkLoading: link.isLoading };
}

export function usePairFavourites() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: pairFavourites,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: favouritesKeys.status });
      void client.invalidateQueries({ queryKey: favouritesKeys.list });
    },
  });
}

export function useDisconnectFavourites() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: disconnectFavourites,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: favouritesKeys.status });
      void client.invalidateQueries({ queryKey: favouritesKeys.list });
    },
  });
}

export function useToggleFavourite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setFavourite,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: favouritesKeys.list });
    },
  });
}

// What the setup holds of one title (the ownership line). Only asked when the
// browser is linked; the answer is counts, never titles or files.
export function useOwned(entry: { mediaType: FavouriteKind; tmdbId: number } | null, linked: boolean) {
  const query = useQuery({
    queryKey: favouritesKeys.owned(entry?.mediaType ?? 'none', entry?.tmdbId ?? 0),
    queryFn: () => fetchOwned(entry ? [entry] : []),
    enabled: linked && Boolean(entry),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });
  return query.data?.items?.[0] ?? null;
}

// What they hold, in the shape the title panel needs to describe it: whole
// seasons, and the ones they are part-way through. Null when they do not have
// the title at all (which is the common case on Releases).
export interface HeldSeasons {
  complete: number[];
  partial: { season: number; owned: number; total: number | null }[];
  // Seasons the show has that the setup does not hold at all. Only filled when
  // the caller knows how many the show has, which is what stops a page saying
  // "in your library" for a show whose latest seasons are missing.
  missing: number[];
}

function isComplete(season: { owned: number; total: number | null; pack?: boolean }): boolean {
  if (season.pack === true) return true;
  // Only when we know how long the season is AND they hold that many. A missing
  // or zero length means "TMDB has not told us yet", never evidence of a full
  // season: treating it as a number made every held season look complete.
  return season.total !== null && season.total > 0 && season.owned >= season.total;
}

export function heldSeasons(owned: OwnedEntry | null, numberOfSeasons: number | null = null): HeldSeasons | null {
  if (!owned || !owned.owned) return null;
  if (owned.mediaType === 'movie') return { complete: [], partial: [], missing: [] };
  // A pack row holds the season with no episode count of its own, so it stays.
  const held = owned.seasons.filter((season) => season.season > 0 && (season.owned > 0 || season.pack === true));
  const complete = held.filter(isComplete).map((season) => season.season);
  const partial = held
    .filter((season) => !isComplete(season))
    .map((season) => ({ season: season.season, owned: season.owned, total: season.total }));
  const have = new Set(held.map((season) => season.season));
  const missing: number[] = [];
  const total = Number(numberOfSeasons);
  if (Number.isInteger(total) && total > 0 && total <= 200) {
    for (let season = 1; season <= total; season += 1) if (!have.has(season)) missing.push(season);
  }
  return { complete, partial, missing };
}

// 1,2,3,7,8 becomes 1-3,7-8: a 30-season show must not read as a wall of
// numbers, and the ranges keep the line short on a phone.
export function seasonRanges(seasons: number[]): { from: number; to: number }[] {
  const sorted = [...new Set(seasons.filter((season) => Number.isInteger(season) && season > 0))].sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  for (const season of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && season === last.to + 1) last.to = season;
    else ranges.push({ from: season, to: season });
  }
  return ranges;
}
