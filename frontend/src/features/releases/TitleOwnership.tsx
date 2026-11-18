import { useTranslation } from 'react-i18next';
import {
  heldSeasons, seasonRanges, useFavourites, useFavouritesLink, useOwned, useToggleFavourite,
} from '@/features/releases/favourites-link';

// The ownership line and the star on a release's own page (v6.1).
//
// Only shown once this browser is linked, and only ever describes what the
// setup actually holds. It has to be unambiguous: a show whose latest seasons
// are missing must never read as "you have it". So the partial seasons come
// first ("S30 has 7 of 52 episodes"), then the seasons nothing is held for
// ("Not in your library: S31-S34"), and the whole ones are compressed to a
// range ("Complete: S1-S29").

export function TitleOwnership({ mediaType, tmdbId, title, numberOfSeasons }: {
  mediaType: 'movie' | 'series';
  tmdbId: number;
  title: string;
  numberOfSeasons?: number | null;
}) {
  const { t } = useTranslation('site');
  const link = useFavouritesLink();
  const linked = link.data?.linked === true;
  const owned = useOwned(linked ? { mediaType, tmdbId } : null, linked);
  const favourites = useFavourites();
  const toggle = useToggleFavourite();
  if (!linked) return null;

  const held = heldSeasons(owned, numberOfSeasons ?? null);
  const starred = (favourites.data?.items ?? []).some((item) => item.mediaType === mediaType && item.tmdbId === tmdbId);
  const seasonLabel = (season: number) => t('releases.favourites.seasonShort', { season });
  const rangeLabel = (from: number, to: number) => (from === to
    ? seasonLabel(from)
    : `${seasonLabel(from)}-${seasonLabel(to)}`);
  const listLabel = (seasons: number[]) => seasonRanges(seasons).map((range) => rangeLabel(range.from, range.to)).join(', ');
  const heldCount = held ? held.complete.length + held.partial.length : 0;

  return (
    <div className="rel-owned">
      {held ? (
        <span className="rel-owned-state">
          <span className="rel-owned-dot" aria-hidden="true" />
          <span>
            <strong>
              {numberOfSeasons && numberOfSeasons > 1
                ? t('releases.favourites.inLibrarySome', { title, held: heldCount, total: numberOfSeasons })
                : t('releases.favourites.inLibrary', { title })}
            </strong>
            {held.partial.map((season) => (
              <small key={season.season} className="rel-owned-gap">
                {season.total !== null && season.total > 0
                  ? t('releases.favourites.partialEpisodes', { season: seasonLabel(season.season), owned: season.owned, total: season.total })
                  : t('releases.favourites.partialUnknown', { season: seasonLabel(season.season), owned: season.owned })}
              </small>
            ))}
            {held.missing.length > 0 && (
              <small className="rel-owned-missing-line">
                {t('releases.favourites.missing', { seasons: listLabel(held.missing) })}
              </small>
            )}
            {held.complete.length > 0 && (
              <small>{t('releases.favourites.complete', { seasons: listLabel(held.complete) })}</small>
            )}
          </span>
        </span>
      ) : (
        <span className="rel-owned-state rel-owned-missing">
          <span className="rel-owned-dot" aria-hidden="true" />
          <span><small>{t('releases.favourites.notInLibrary')}</small></span>
        </span>
      )}
      {held ? (
        <button
          type="button"
          className={starred ? 'rel-star is-on' : 'rel-star'}
          aria-pressed={starred}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ mediaType, tmdbId, wanted: !starred })}
          title={starred ? t('releases.favourites.unstar') : t('releases.favourites.star')}
        >
          <span aria-hidden="true">{starred ? '★' : '☆'}</span>
          {starred ? t('releases.favourites.starred') : t('releases.favourites.star')}
        </button>
      ) : (favourites.data?.items ?? []).some((item) => item.mediaType === mediaType && item.tmdbId === tmdbId) && (
        <button
          type="button" className="rel-star"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ mediaType, tmdbId, wanted: false })}
        >
          {t('releases.favourites.unstar')}
        </button>
      )}
    </div>
  );
}
