'use strict';
// "Is this debrid key accepted?" - one lightweight account call per provider,
// used when a setup is created or a provider key is saved, so a pasted-wrong
// or regenerated key is caught at once instead of showing an empty library
// days later (a failed scan stores no items, and then nothing shows anywhere).
//
// Only a definite rejection blocks a save. `unknown` means the provider could
// not be asked (timeout, 5xx, outage) and must never stop someone editing a
// setup. Keys are trimmed on the way in: a pasted trailing space is a common
// cause of a rejected key.

export type ProviderKeyId = 'torbox' | 'realdebrid' | 'alldebrid' | 'premiumize';
export type ProviderKeyState = 'ok' | 'invalid' | 'unknown';

export interface ProviderKeyCheck {
  provider: ProviderKeyId;
  state: ProviderKeyState;
}

export interface ProviderKeyDeps {
  torbox?: (key: string) => Promise<ProviderKeyState>;
  realdebrid?: (key: string) => Promise<ProviderKeyState>;
  alldebrid?: (key: string) => Promise<ProviderKeyState>;
  premiumize?: (key: string) => Promise<ProviderKeyState>;
}

interface ProviderField {
  field: string;
  label: string;
}

const PROVIDERS: Record<ProviderKeyId, ProviderField> = {
  torbox: { field: 'torboxApiKey', label: 'TorBox' },
  realdebrid: { field: 'rdApiKey', label: 'Real-Debrid' },
  alldebrid: { field: 'adApiKey', label: 'AllDebrid' },
  premiumize: { field: 'pmApiKey', label: 'Premiumize' },
};

const ORDER: ProviderKeyId[] = ['torbox', 'realdebrid', 'alldebrid', 'premiumize'];

// 401/403 is a rejected key; provider wording such as "invalid apikey" or
// "bad_token" is too. Anything else (timeout, 5xx, DNS) is unknown.
function classify(status: number | undefined, message: unknown): ProviderKeyState {
  if (status === 401 || status === 403) return 'invalid';
  const text = String(message || '');
  if (/invalid|unauthori[sz]ed|forbidden|authentication|bad_token|apikey|api key|expired|not authori[sz]ed/i.test(text)) return 'invalid';
  return 'unknown';
}

function statusOf(error: any): number {
  return Number(error?.response?.status) || 0;
}

function providerKey(record: Record<string, unknown>, provider: ProviderKeyId): string {
  return String(record[PROVIDERS[provider].field] ?? '').trim();
}

async function defaultCheck(provider: ProviderKeyId, key: string): Promise<ProviderKeyState> {
  if (provider === 'torbox') {
    const { verifyTorBoxKey } = require('./torbox.ts') as { verifyTorBoxKey: (k: string) => Promise<{ valid: boolean; status?: number; error?: string }> };
    const out = await verifyTorBoxKey(key);
    return out.valid ? 'ok' : classify(out.status, out.error);
  }
  if (provider === 'realdebrid') {
    const { realDebridProbeGet } = require('./realdebrid.ts') as { realDebridProbeGet: (k: string, path: string) => Promise<unknown> };
    try {
      await realDebridProbeGet(key, '/user');
      return 'ok';
    } catch (err: any) {
      return classify(statusOf(err), err?.response?.data?.error || err?.message);
    }
  }
  if (provider === 'alldebrid') {
    const { verifyAlldebridKey } = require('./alldebrid.ts') as { verifyAlldebridKey: (k: string) => Promise<{ valid: boolean; error?: string; status?: number }> };
    const out = await verifyAlldebridKey(key);
    return out.valid ? 'ok' : classify(out.status, out.error);
  }
  const { verifyPremiumizeKey } = require('./premiumize.ts') as { verifyPremiumizeKey: (k: string) => Promise<{ valid: boolean; error?: string; status?: number; needPin?: boolean }> };
  const out = await verifyPremiumizeKey(key);
  if (out.valid) return 'ok';
  // A key that needs device authorization is not usable yet: treat it the
  // same as a rejected key so the person is told rather than ignored.
  return out.needPin ? 'invalid' : classify(out.status, out.error);
}

async function checkProviderKey(provider: ProviderKeyId, rawKey: unknown, deps: ProviderKeyDeps = {}): Promise<ProviderKeyCheck> {
  const key = String(rawKey ?? '').trim();
  if (!key) return { provider, state: 'invalid' };
  const check = deps[provider] || ((value: string) => defaultCheck(provider, value));
  try {
    return { provider, state: await check(key) };
  } catch {
    return { provider, state: 'unknown' };
  }
}

// Trim the four provider keys in a create/save body and check the ones it
// carries. Existing keys are not re-checked: a save that does not touch them
// must work even while a provider is down.
async function checkProviderKeys(
  record: Record<string, unknown>,
  deps: ProviderKeyDeps = {}
): Promise<{ keys: Record<string, unknown>; rejected: { provider: ProviderKeyId; label: string } | null }> {
  const keys: Record<string, unknown> = { ...record };
  for (const provider of ORDER) {
    const field = PROVIDERS[provider].field;
    if (typeof keys[field] === 'string') keys[field] = (keys[field] as string).trim();
  }
  const present = ORDER.filter((provider) => providerKey(keys, provider));
  if (!present.length) return { keys, rejected: null };
  const results = await Promise.all(present.map((provider) => checkProviderKey(provider, providerKey(keys, provider), deps)));
  const failed = results.find((result) => result.state === 'invalid');
  return { keys, rejected: failed ? { provider: failed.provider, label: PROVIDERS[failed.provider].label } : null };
}

export interface ProviderKeyCheckApi {
  PROVIDER_KEY_FIELDS: Record<ProviderKeyId, string>;
  PROVIDER_LABELS: Record<ProviderKeyId, string>;
  checkProviderKey: typeof checkProviderKey;
  checkProviderKeys: typeof checkProviderKeys;
  classify: typeof classify;
}

const PROVIDER_KEY_FIELDS: Record<ProviderKeyId, string> = {
  torbox: PROVIDERS.torbox.field,
  realdebrid: PROVIDERS.realdebrid.field,
  alldebrid: PROVIDERS.alldebrid.field,
  premiumize: PROVIDERS.premiumize.field,
};

const PROVIDER_LABELS: Record<ProviderKeyId, string> = {
  torbox: PROVIDERS.torbox.label,
  realdebrid: PROVIDERS.realdebrid.label,
  alldebrid: PROVIDERS.alldebrid.label,
  premiumize: PROVIDERS.premiumize.label,
};

module.exports = {
  PROVIDER_KEY_FIELDS,
  PROVIDER_LABELS,
  checkProviderKey,
  checkProviderKeys,
  classify,
} satisfies ProviderKeyCheckApi;
