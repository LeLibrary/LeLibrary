// What the library banner should say when the last scan failed. A failed scan
// stores no items, so without this an empty library and an empty debrid
// account look identical: "nothing shows, it is not working at all".
// Returns a kind (translated in the panel), not prose. Pure for unit tests.
import type { LibrarySummary } from './library-api';

export type ScanNotice =
  | { kind: 'rejected'; tone: 'error'; provider: string | null }
  | { kind: 'failed'; tone: 'error' | 'warn'; error: string | null };

type Summary = Pick<LibrarySummary, 'lastStatus' | 'files'> & {
  lastError?: string | null;
};

const PROVIDER_LABELS: [RegExp, string][] = [
  [/torbox/i, 'TorBox'],
  [/\[RD\]|real-?debrid/i, 'Real-Debrid'],
  [/alldebrid/i, 'AllDebrid'],
  [/premiumize/i, 'Premiumize'],
];

// Wording each provider (or our adapter) uses when it rejected the key, as
// opposed to being unreachable.
const REJECTED = /authentication failed|bad_token|apikey is invalid|invalid [^.]*key|not authori[sz]ed|unauthori[sz]ed|forbidden|expired/i;

export function scanNotice(summary: Summary | null | undefined): ScanNotice | null {
  if (!summary || summary.lastStatus !== 'error') return null;
  const error = String(summary.lastError || '');
  if (REJECTED.test(error)) {
    const provider = PROVIDER_LABELS.find(([pattern]) => pattern.test(error))?.[1] ?? null;
    return { kind: 'rejected', tone: 'error', provider };
  }
  return { kind: 'failed', tone: summary.files > 0 ? 'warn' : 'error', error: error ? error.slice(0, 160) : null };
}
