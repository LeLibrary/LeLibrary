import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Forgot password / delete my setup. The flow talks to /api/reset/*; the
// install link and the API key must live in component state only.
const api = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
}));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiClient: api,
}));

const { ApiError } = await import('@/api/client');
const reset = await import('@/api/reset');
const model = await import('@/features/setup/reset/reset-model');
const { ResetPage, RedeemForm, TrackRequest, describeFailure } = await import('@/features/setup/reset/ResetPage');
const { UnlockRecovery } = await import('@/features/setup/reset/ForgotPasswordLink');
const { queryKeys } = await import('@/api/query-keys');

const UUID = '11111111-2222-3333-4444-555555555555';

function render(node: ReactNode, config?: { enabled: boolean; siteKey: string }, url = '/reset') {
  const client = new QueryClient();
  if (config) client.setQueryData(queryKeys.resetConfig, config);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { vi.clearAllMocks(); });

describe('config gate', () => {
  it('disabled: the unlock modal shows the old note and no link', () => {
    const html = render(<UnlockRecovery uuid={UUID} />, { enabled: false, siteKey: '' });
    expect(html).toContain('No email, no recovery');
    expect(html).not.toContain('Forgot your password?');
  });

  it('enabled: the unlock modal links to /reset with the setup id', () => {
    const html = render(<UnlockRecovery uuid={UUID} />, { enabled: true, siteKey: '' });
    expect(html).toContain('Forgot your password?');
    expect(html).toContain(`href="/reset?setup=${UUID}"`);
    expect(html).not.toContain('No email, no recovery');
  });

  it('shows nothing until the answer is known', () => {
    expect(render(<UnlockRecovery uuid={UUID} />)).toBe('');
  });

  it('an older server without the route counts as disabled', async () => {
    api.get.mockRejectedValueOnce(new ApiError('Not found', 404, null));
    await expect(reset.fetchResetConfig()).resolves.toEqual({ enabled: false, siteKey: '' });
  });

  it('the page offers no form when the feature is off', () => {
    const html = render(<ResetPage />, { enabled: false, siteKey: '' });
    expect(html).toContain('Password reset is not available on this server.');
    expect(html).not.toContain('type="password"');
  });
});

describe('step 1 form', () => {
  const html = render(<ResetPage />, { enabled: true, siteKey: '' }, `/reset?setup=${UUID}`);

  it('offers both actions, the id hint, and masked non-autofilled fields', () => {
    expect(html).toContain('Reset my password');
    expect(html).toContain('Delete my setup');
    expect(html).toContain(UUID);
    expect(html).toContain('One of your saved API keys (for example your TorBox or Real-Debrid key)');
    expect((html.match(/type="password" autoComplete="off"/g) ?? []).length).toBe(2);
  });

  it('holds Continue until both fields are filled', () => {
    expect(html).toMatch(/reset-submit" disabled/);
    expect(model.stepOneReady({ link: 'x', key: '', tokenReady: true })).toBe(false);
    expect(model.stepOneReady({ link: 'x', key: 'k', tokenReady: false })).toBe(false);
    expect(model.stepOneReady({ link: ` ${UUID}.secret `, key: 'k', tokenReady: true })).toBe(true);
  });

  it('ignores a malformed ?setup= hint', () => {
    expect(render(<ResetPage />, { enabled: true, siteKey: '' }, '/reset?setup=nope')).not.toContain('Setup id');
  });
});

describe('request, poll and redeem calls', () => {
  it('walks the reset path with the documented bodies', async () => {
    api.post.mockResolvedValueOnce({ requestId: 'ABCD-1234', expiresAt: '2026-11-11T12:00:00Z', action: 'reset' });
    const made = await reset.requestReset({
      installToken: ` stremio://x/${UUID}.secret/manifest.json `, key: ' my-key ', action: 'reset', turnstile: 'tok',
    });
    expect(made.requestId).toBe('ABCD-1234');
    expect(api.post).toHaveBeenLastCalledWith('/api/reset/request', {
      installToken: `stremio://x/${UUID}.secret/manifest.json`, key: 'my-key', action: 'reset', 'cf-turnstile-response': 'tok',
    });

    api.get.mockResolvedValueOnce({ status: 'code_sent', action: 'reset', codeExpiresAt: '2026-11-11T12:15:00Z', expiresAt: '2026-11-11T12:30:00Z' });
    await expect(reset.fetchResetStatus('ABCD-1234')).resolves.toMatchObject({ status: 'code_sent', action: 'reset' });
    expect(api.get).toHaveBeenLastCalledWith('/api/reset/status/ABCD-1234', {});

    api.post.mockResolvedValueOnce({ ok: true, action: 'reset' });
    await reset.redeemReset({ requestId: 'ABCD-1234', code: model.formatCode('abcd2345'), newPassword: 'a-new-password' });
    expect(api.post).toHaveBeenLastCalledWith('/api/reset/redeem', {
      requestId: 'ABCD-1234', code: 'ABCD-2345', newPassword: 'a-new-password',
    });
  });

  it('sends no token field when Turnstile is off, and confirmDelete for deletes', async () => {
    api.post.mockResolvedValue({});
    await reset.requestReset({ installToken: 'a', key: 'b', action: 'delete' });
    expect(api.post.mock.calls[0]?.[1]).not.toHaveProperty('cf-turnstile-response');
    await reset.redeemReset({ requestId: 'ABCD-1234', code: 'ABCD-2345', confirmDelete: true });
    expect(api.post).toHaveBeenLastCalledWith('/api/reset/redeem', { requestId: 'ABCD-1234', code: 'ABCD-2345', confirmDelete: true });
  });

  it('knows which statuses end the poll', () => {
    for (const status of ['done', 'denied', 'closed'] as const) expect(reset.isTerminalStatus(status)).toBe(true);
    for (const status of ['waiting_discord', 'waiting_approval', 'approved', 'code_sent'] as const) expect(reset.isTerminalStatus(status)).toBe(false);
    expect(reset.normalizeResetStatus({ status: 'bogus' }).status).toBe('waiting_discord');
  });
});

describe('step 2 and 3', () => {
  it('shows the request id and the Discord instructions', () => {
    const html = render(<TrackRequest request={{ requestId: 'ABCD-1234', action: 'reset' }} onRedeemed={() => {}} onRestart={() => {}} />);
    expect(html).toContain('ABCD-1234');
    expect(html).toContain('/reset command');
    expect(html).toContain('30 minutes');
    expect(html).toContain('15 minutes');
    expect(html).toContain('Waiting for you to send the request id in Discord.');
    expect(html).toContain('One-time code');
  });

  it('reset form asks for a new password twice and never mentions a bot password', () => {
    const html = render(<RedeemForm requestId="ABCD-1234" action="reset" onRedeemed={() => {}} />);
    expect(html).toContain('New password');
    expect(html).toContain('Confirm new password');
    expect(html).toMatch(/reset-submit" disabled/);
    expect(html).not.toContain('checkbox');
  });

  it('delete form warns and holds the button behind the checkbox', () => {
    const html = render(<RedeemForm requestId="ABCD-1234" action="delete" onRedeemed={() => {}} />);
    expect(html).toContain('Deleting is permanent');
    expect(html).toContain('I understand this deletes my setup permanently');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('New password');
    expect(html).toMatch(/btn-danger reset-submit" disabled/);
  });

  it('delete needs a full code and the checkbox', () => {
    const base = { action: 'delete' as const, code: 'ABCD-2345', password: '', confirmation: '', understood: false };
    expect(model.redeemReady(base)).toBe(false);
    expect(model.redeemReady({ ...base, understood: true })).toBe(true);
    expect(model.redeemReady({ ...base, understood: true, code: 'ABCD' })).toBe(false);
  });

  it('reset blocks short and mismatched passwords before any request', () => {
    const base = { action: 'reset' as const, code: 'ABCD-2345', understood: false };
    expect(model.passwordProblem('short', 'short')).toBe('short');
    expect(model.passwordProblem('a-long-enough', 'a-long-enouGH')).toBe('mismatch');
    expect(model.passwordProblem('x'.repeat(257), 'x'.repeat(257))).toBe('long');
    expect(model.passwordProblem('a-long-enough', 'a-long-enough')).toBeNull();
    expect(model.redeemReady({ ...base, password: 'short', confirmation: 'short' })).toBe(false);
    expect(model.redeemReady({ ...base, password: 'a-long-enough', confirmation: 'different-one' })).toBe(false);
    expect(model.redeemReady({ ...base, password: 'a-long-enough', confirmation: 'a-long-enough' })).toBe(true);
    expect(model.redeemReady({ ...base, code: 'ABC', password: 'a-long-enough', confirmation: 'a-long-enough' })).toBe(false);
  });

  it('normalises the code to XXXX-XXXX', () => {
    expect(model.formatCode('abcd2345')).toBe('ABCD-2345');
    expect(model.formatCode('abcd-2345')).toBe('ABCD-2345');
    expect(model.formatCode(' ab cd 23 ')).toBe('ABCD-23');
    expect(model.formatCode('abcd2345zzzz')).toBe('ABCD-2345');
    expect(model.formatCode('ab')).toBe('AB');
  });

  it('finds the setup id for the success link', () => {
    expect(model.setupIdFromLink(`https://x.test/${UUID.toUpperCase()}.secret/manifest.json`)).toBe(UUID);
    expect(model.setupIdFromLink('nothing here')).toBeNull();
  });
});

describe('errors', () => {
  it('shows the server message as sent', () => {
    expect(describeFailure(new ApiError('Those details did not match this setup.', 401, null), 'x'))
      .toEqual({ text: 'Those details did not match this setup.', server: true });
  });

  it('turns a 429 with Retry-After into a wait in minutes', () => {
    const error = new ApiError('Too many attempts. Try again later.', 429, null);
    error.retryAfterSeconds = 61;
    expect(describeFailure(error, 'x')).toEqual({ text: 'Too many attempts. Try again in about 2 min.', server: false });
  });

  it('a 429 without a wait falls back to the server message', () => {
    expect(describeFailure(new ApiError('Too many attempts. Try again later.', 429, null), 'x').server).toBe(true);
  });

  it('a network failure gets our own fallback line', () => {
    expect(describeFailure(new Error('boom'), 'Could not send the request. Try again.'))
      .toEqual({ text: 'Could not send the request. Try again.', server: false });
  });
});

describe('secrets stay out of storage', () => {
  it('never calls Web Storage while requesting', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    api.post.mockResolvedValue({ requestId: 'ABCD-1234', expiresAt: '', action: 'reset' });
    render(<ResetPage />, { enabled: true, siteKey: '' });
    await reset.requestReset({ installToken: `${UUID}.secret`, key: 'secret-key', action: 'reset' });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('the reset sources do not reference storage or the draft store', () => {
    const dir = fileURLToPath(new URL('./', import.meta.url));
    const files = readdirSync(dir).filter((name) => /\.(tsx?|css)$/.test(name) && !name.includes('.test.'))
      .map((name) => dir + name);
    files.push(fileURLToPath(new URL('../../../api/reset.ts', import.meta.url)));
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/localStorage|sessionStorage|draft-secrets|useDraft|indexedDB/);
    }
  });
});
