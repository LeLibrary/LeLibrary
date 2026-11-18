import { useTranslation } from 'react-i18next';
import {
  heldSeasons, useFavourites, useFavouritesLink, useOwned, useToggleFavourite,
} from '@/features/releases/favourites-link';

// The ownership line and the star on a release's own page (v6.1).
//
// Only shown once this browser is linked, and only ever describes what the
// setup actually holds: "in your library", "seasons 1 and 2 complete, season 3
// 4 of 10". Starring something they do not have is not offered, because the
// Favourites folder is built from their library.

export function TitleOwnership({ mediaType, tmdbId, title }: {
  mediaType: 'movie' | 'series';
  tmdbId: number;
  title: string;
}) {
  const { t } = useTranslation('site');
  const link = useFavouritesLink();
  const linked = link.data?.linked === true;
  const owned = useOwned(linked ? { mediaType, tmdbId } : null, linked);
  const favourites = useFavourites();
  const toggle = useToggleFavourite();
  if (!linked) return null;

  const held = heldSeasons(owned);
  const starred = (favourites.data?.items ?? []).some((item) => item.mediaType === mediaType && item.tmdbId === tmdbId);
  const seasons = owned?.seasons ?? [];

  function seasonName(season: number): string {
    return t('releases.detail.season', { season });
  }

  return (
    <div className="rel-owned">
      {held ? (
        <span className="rel-owned-state">
          <span className="rel-owned-dot" aria-hidden="true" />
          <span>
            <strong>{t('releases.favourites.inLibrary', { title })}</strong>
            {held.complete.length > 0 && (
              <small>{t('releases.favourites.complete', { seasons: held.complete.map(seasonName).join(', ') })}</small>
            )}
            {held.partial.length > 0 && (
              <small>
                {held.partial
                  .map((season) => (season.total === null
                    ? t('releases.favourites.partialUnknown', { season: seasonName(season.season), owned: season.owned })
                    : t('releases.favourites.partial', { season: seasonName(season.season), owned: season.owned, total: season.total })))
                  .join(' · ')}
              </small>
            )}
          </span>
        </span>
      ) : (
        <span className="rel-owned-state rel-owned-missing">
          <span className="rel-owned-dot" aria-hidden="true" />
          <span><small>{t('releases.favourites.notInLibrary')}</small></span>
        </span>
      )}
      {held && (
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
      )}
      {!held && (favourites.data?.items ?? []).some((item) => item.mediaType === mediaType && item.tmdbId === tmdbId) && (
        <button
          type="button" className="rel-star"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ mediaType, tmdbId, wanted: false })}
        >
          {t('releases.favourites.unstar')}
        </button>
      )}
      {seasons.length > 0 && held && (
        <span className="rel-owned-seasons">
          {seasons.filter((season) => season.season > 0).map((season) => (
            <span
              key={season.season}
              className={season.total !== null && season.owned >= season.total ? 'rel-owned-chip is-full' : 'rel-owned-chip'}
            >
              {seasonName(season.season)}
              {season.total !== null ? ` ${season.owned}/${season.total}` : ` ${season.owned}`}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
