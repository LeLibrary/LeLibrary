import { apiClient } from '@/api/client';

// Favourites (v6.1): the setup's own shortlist. Every call carries the bearer
// edit token; the server stores a TMDB id and a kind, and answers with the
// labels it can read from this setup's own library.

export type FavouriteMediaType = 'movie' | 'series';

export interface FavouriteItem {
  mediaType: FavouriteMediaType;
  tmdbId: number;
  addedAt: string;
  title: string;
  year: string | null;
  poster: string | null;
}

export interface FavouritesResponse {
  items: FavouriteItem[];
  limit: number;
}

function auth(editToken: string): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${editToken}` } };
}

function base(uuid: string): string {
  return `/api/setup/${encodeURIComponent(uuid)}/favourites`;
}

export function fetchFavourites(uuid: string, editToken: string): Promise<FavouritesResponse> {
  return apiClient.get<FavouritesResponse>(base(uuid), auth(editToken));
}

export function addFavourite(uuid: string, editToken: string, mediaType: FavouriteMediaType, tmdbId: number): Promise<{ saved: boolean; created: boolean }> {
  return apiClient.post<{ saved: boolean; created: boolean }>(base(uuid), { mediaType, tmdbId }, auth(editToken));
}

export function removeFavourite(uuid: string, editToken: string, mediaType: FavouriteMediaType, tmdbId: number): Promise<{ removed: boolean }> {
  return apiClient.delete<{ removed: boolean }>(`${base(uuid)}/${mediaType}/${tmdbId}`, undefined, auth(editToken));
}

export function favouriteKey(mediaType: FavouriteMediaType, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

// The Releases page connection (v6.1): a short code from here, redeemed there
// for a scoped cookie. Nothing but this list and those counts leaves the
// server, and any of these can be cut off at any time.
export interface FavouritesPairing {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function createPairCode(uuid: string, editToken: string): Promise<{ code: string; expiresAt: string }> {
  return apiClient.post<{ code: string; expiresAt: string }>(`${base(uuid)}/pair`, {}, auth(editToken));
}

export function fetchPairings(uuid: string, editToken: string): Promise<{ pairings: FavouritesPairing[] }> {
  return apiClient.get<{ pairings: FavouritesPairing[] }>(`${base(uuid)}/pairings`, auth(editToken));
}

export function revokePairing(uuid: string, editToken: string, pairingId: string): Promise<{ revoked: boolean }> {
  return apiClient.delete<{ revoked: boolean }>(`${base(uuid)}/pairings/${encodeURIComponent(pairingId)}`, undefined, auth(editToken));
}

export function clearFavourites(uuid: string, editToken: string): Promise<{ cleared: number }> {
  return apiClient.post<{ cleared: number }>(`${base(uuid)}/clear`, {}, auth(editToken));
}
