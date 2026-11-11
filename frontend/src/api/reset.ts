import { apiClient } from '@/api/client';

// Forgot password / delete my setup (v6). The server side lives in
// backend/src/routes/reset.ts. Nothing here is stored: the install link and the
// API key go straight into one request and are never kept by the caller.

export type ResetAction = 'reset' | 'delete';

export interface ResetConfig {
  enabled: boolean;
  siteKey: string;
  // The operator must approve every request by hand (default: false).
  requiresApproval: boolean;
}

export type ResetStatusName =
  | 'waiting_discord' | 'waiting_approval' | 'approved' | 'code_sent' | 'done' | 'denied' | 'closed';

export interface ResetRequestResult {
  requestId: string;
  expiresAt: string;
  action: ResetAction;
}

export interface ResetStatus {
  status: ResetStatusName;
  action: ResetAction;
  codeExpiresAt: string | null;
  expiresAt: string;
}

const STATUSES: readonly ResetStatusName[] = [
  'waiting_discord', 'waiting_approval', 'approved', 'code_sent', 'done', 'denied', 'closed',
];

export const TERMINAL_STATUSES: readonly ResetStatusName[] = ['done', 'denied', 'closed'];

export function isTerminalStatus(status: ResetStatusName): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function normalizeResetConfig(payload: unknown): ResetConfig {
  const record = (payload ?? {}) as Record<string, unknown>;
  const siteKey = typeof record['siteKey'] === 'string' ? record['siteKey'].trim() : '';
  return { enabled: record['enabled'] === true, siteKey, requiresApproval: record['requiresApproval'] === true };
}

export function normalizeResetStatus(payload: unknown): ResetStatus {
  const record = (payload ?? {}) as Record<string, unknown>;
  const status = STATUSES.find((name) => name === record['status']) ?? 'waiting_discord';
  return {
    status,
    action: record['action'] === 'delete' ? 'delete' : 'reset',
    codeExpiresAt: typeof record['codeExpiresAt'] === 'string' ? record['codeExpiresAt'] : null,
    expiresAt: typeof record['expiresAt'] === 'string' ? record['expiresAt'] : '',
  };
}

export async function fetchResetConfig(signal?: AbortSignal): Promise<ResetConfig> {
  try {
    return normalizeResetConfig(await apiClient.get<unknown>('/api/reset/config', signal ? { signal } : {}));
  } catch {
    // An older server without the route: the feature is simply off.
    return { enabled: false, siteKey: '', requiresApproval: false };
  }
}

export function requestReset(input: {
  installToken: string;
  key: string;
  action: ResetAction;
  turnstile?: string | null;
}): Promise<ResetRequestResult> {
  return apiClient.post<ResetRequestResult>('/api/reset/request', {
    installToken: input.installToken.trim(),
    key: input.key.trim(),
    action: input.action,
    ...(input.turnstile ? { 'cf-turnstile-response': input.turnstile } : {}),
  });
}

export async function fetchResetStatus(requestId: string, signal?: AbortSignal): Promise<ResetStatus> {
  return normalizeResetStatus(
    await apiClient.get<unknown>(`/api/reset/status/${encodeURIComponent(requestId)}`, signal ? { signal } : {}),
  );
}

export function redeemReset(input:
  | { requestId: string; code: string; newPassword: string }
  | { requestId: string; code: string; confirmDelete: true },
): Promise<{ ok: true; action: ResetAction }> {
  return apiClient.post<{ ok: true; action: ResetAction }>('/api/reset/redeem', input);
}
