import type { ResetAction, ResetStatusName } from '@/api/reset';

// Pure pieces of the forgot-password flow, kept apart so they are testable
// without a DOM. Nothing here touches storage.

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;

const UUID_RE = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;

/** The setup id inside an install link or token, or null. Never a secret. */
export function setupIdFromLink(link: string): string | null {
  const match = UUID_RE.exec(link);
  return match ? match[0].toLowerCase() : null;
}

/** A `?setup=` hint only counts when it is a whole, well-formed id. */
export function cleanSetupHint(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return new RegExp(`^${UUID_RE.source}$`, 'i').test(text) ? text.toLowerCase() : null;
}

/** What the person typed, shown as XXXX-XXXX: upper case, dash after four. */
export function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function codeComplete(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

export type PasswordProblem = 'short' | 'long' | 'mismatch' | null;

export function passwordProblem(password: string, confirmation: string): PasswordProblem {
  if (password.length < MIN_PASSWORD) return 'short';
  if (password.length > MAX_PASSWORD) return 'long';
  if (password !== confirmation) return 'mismatch';
  return null;
}

export const PASSWORD_PROBLEM_COPY: Record<Exclude<PasswordProblem, null>, string> = {
  short: 'Choose a password of at least 8 characters.',
  long: 'Choose a password of at most 256 characters.',
  mismatch: 'The two passwords do not match.',
};

export function stepOneReady(input: { link: string; key: string; tokenReady: boolean }): boolean {
  return input.link.trim().length > 0 && input.key.trim().length > 0 && input.tokenReady;
}

export function redeemReady(input: {
  action: ResetAction; code: string; password: string; confirmation: string; understood: boolean;
}): boolean {
  if (!codeComplete(input.code)) return false;
  if (input.action === 'delete') return input.understood;
  return passwordProblem(input.password, input.confirmation) === null;
}

export const STATUS_COPY: Record<ResetStatusName, string> = {
  waiting_discord: 'Waiting for you to send the request id in Discord.',
  waiting_approval: 'Linked. Waiting for the operator to approve it.',
  approved: 'Approved. Check your Discord DMs: your code arrives within about a minute.',
  code_sent: 'Your code was sent by Discord DM. Enter it below.',
  done: 'This request is finished.',
  denied: 'The operator denied this request.',
  closed: 'This request expired or was closed.',
};

/** Minutes to wait after a 429, rounded up; null when the server gave no wait. */
export function retryMinutes(seconds: number | undefined): number | null {
  if (!seconds || seconds <= 0) return null;
  return Math.max(1, Math.ceil(seconds / 60));
}
