// The library banner that explains a failed scan: an empty library must say
// why it is empty instead of looking like the addon does nothing.
import { describe, expect, it } from 'vitest';
import { scanNotice } from '@/features/setup/library/scan-notice';

const base = { lastStatus: 'ok' as string | null, files: 0, lastError: null as string | null };

describe('scan notice', () => {
  it('says nothing when the last scan succeeded', () => {
    expect(scanNotice(null)).toBeNull();
    expect(scanNotice({ ...base, files: 12 })).toBeNull();
  });

  it('names the provider behind a rejected key', () => {
    expect(scanNotice({ ...base, lastStatus: 'error', lastError: 'TorBox authentication failed (401)' }))
      .toEqual({ kind: 'rejected', tone: 'error', provider: 'TorBox' });
    expect(scanNotice({ ...base, lastStatus: 'error', lastError: '[RD] Torrents error: bad_token' }))
      .toEqual({ kind: 'rejected', tone: 'error', provider: 'Real-Debrid' });
    expect(scanNotice({ ...base, lastStatus: 'error', lastError: '[AllDebrid] The auth apikey is invalid' }))
      .toEqual({ kind: 'rejected', tone: 'error', provider: 'AllDebrid' });
    expect(scanNotice({ ...base, lastStatus: 'error', lastError: 'Invalid Premiumize API key' }))
      .toEqual({ kind: 'rejected', tone: 'error', provider: 'Premiumize' });
  });

  it('a provider that did not answer is not blamed on the key', () => {
    const out = scanNotice({ ...base, lastStatus: 'error', lastError: 'connect ETIMEDOUT 1.2.3.4:443' });
    expect(out?.kind).toBe('failed');
    expect(out && 'error' in out ? out.error : '').toContain('ETIMEDOUT');
  });

  it('warns rather than errors when a working library is showing', () => {
    const out = scanNotice({ ...base, files: 40, lastStatus: 'error', lastError: 'TorBox request failed' });
    expect(out).toEqual({ kind: 'failed', tone: 'warn', error: 'TorBox request failed' });
    expect(scanNotice({ ...base, lastStatus: 'error', lastError: null })?.tone).toBe('error');
  });
});
