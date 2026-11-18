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
  seasons: { season: number; owned: number; total: number | null }[];
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
}

export function heldSeasons(owned: OwnedEntry | null): HeldSeasons | null {
  if (!owned || !owned.owned) return null;
  if (owned.mediaType === 'movie') return { complete: [], partial: [] };
  const held = owned.seasons.filter((season) => season.season > 0 && season.owned > 0);
  if (!held.length) return { complete: [], partial: [] };
  const complete = held.filter((season) => season.total !== null && season.owned >= season.total).map((season) => season.season);
  const partial = held
    .filter((season) => season.total === null || season.owned < season.total)
    .map((season) => ({ season: season.season, owned: season.owned, total: season.total }));
  return { complete, partial };
}
