import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublishPanel } from '@/features/setup/shared/PublishPanel';

// The Jellyfin card lives in "More players": one repository URL (public, the
// same for everyone) and this setup's install link (personal). The plugin asks
// for the user's own debrid key, never ours.
function render() {
  return renderToStaticMarkup(
    <PublishPanel installToken="abc.def" uuid="abc-123" tierLabel="Settle In" platform="stremio" />,
  );
}

describe('Jellyfin card', () => {
  it('offers the plugin repository URL and this setup install link', () => {
    const html = render();
    expect(html).toContain('Jellyfin');
    expect(html).toContain('https://lelibrary.github.io/LeLibrary-Jellyfin/manifest.json');
    expect(html).toContain('/abc.def/manifest.json');
  });

  it('says the plugin asks for the debrid key of the user, not ours', () => {
    expect(render()).toMatch(/your own debrid key/i);
  });
});
