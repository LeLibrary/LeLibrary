import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useDisconnectFavourites, useFavourites, useFavouritesLink, usePairFavourites,
} from '@/features/releases/favourites-link';

// The Releases page's link card (v6.1).
//
// Their setup page shows a short code; this types it in. Nothing here is asked
// for a link, a password or a key, and Unlink cuts the browser off from the
// server side.

export function ReleasesFavouritesLink() {
  const { t } = useTranslation('site');
  const link = useFavouritesLink();
  const favourites = useFavourites();
  const pair = usePairFavourites();
  const disconnect = useDisconnectFavourites();
  const [code, setCode] = useState('');

  // Never take space when the question itself failed (a self-host without the
  // setup database): the page works fine without it.
  if (link.isError) return null;

  if (favourites.linked) {
    return (
      <div className="rel-link rel-link-on">
        <span className="rel-link-dot" aria-hidden="true" />
        <span className="rel-link-text">
          <strong>{t('releases.favourites.linked')}</strong>
          <small>
            {favourites.data && favourites.data.items.length > 0
              ? t('releases.favourites.linkedCount', { count: favourites.data.items.length })
              : t('releases.favourites.linkedEmpty')}
          </small>
        </span>
        <button
          type="button" className="rel-link-btn"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          {t('releases.favourites.unlink')}
        </button>
      </div>
    );
  }

  return (
    <form
      className="rel-link"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (value.length < 4) return;
        pair.mutate(value, { onSuccess: () => setCode('') });
      }}
    >
      <span className="rel-link-text">
        <strong>{t('releases.favourites.linkTitle')}</strong>
        <small>{t('releases.favourites.linkHint')}</small>
      </span>
      <input
        className="rel-link-code"
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 12))}
        placeholder={t('releases.favourites.codePlaceholder')}
        aria-label={t('releases.favourites.codePlaceholder')}
        autoComplete="one-time-code"
        spellCheck={false}
        inputMode="text"
      />
      <button type="submit" className="rel-link-btn" disabled={pair.isPending || code.trim().length < 4}>
        {t('releases.favourites.link')}
      </button>
      {pair.isError && <span className="rel-link-error">{t('releases.favourites.linkError')}</span>}
    </form>
  );
}
