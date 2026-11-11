import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import {
  fetchResetStatus, isTerminalStatus, redeemReset, requestReset,
  type ResetAction, type ResetStatus,
} from '@/api/reset';
import { useResetConfig } from '@/features/setup/reset/ForgotPasswordLink';
import {
  PASSWORD_PROBLEM_COPY, STATUS_COPY, cleanSetupHint, codeComplete, formatCode, passwordProblem,
  redeemReady, retryMinutes, setupIdFromLink, stepOneReady,
} from '@/features/setup/reset/reset-model';
import { TurnstileCheck, useTurnstile } from '@/features/setup/shared/TurnstileCheck';
import { submitWithTurnstile, turnstileReady } from '@/features/setup/shared/turnstile';
import { toast } from '@/features/setup/shared/Toast';
import '@/features/setup/reset/reset.css';

const POLL_MS = 4000;

// A message is either ours (translated) or the server's (shown as sent).
interface Problem { text: string; server: boolean }

export function describeFailure(error: unknown, fallback: string): Problem {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const minutes = retryMinutes(error.retryAfterSeconds);
      if (minutes) return { text: `Too many attempts. Try again in about ${minutes} min.`, server: false };
    }
    return { text: error.message, server: true };
  }
  return { text: fallback, server: false };
}

function ProblemLine({ problem }: { problem: Problem | null }) {
  if (!problem) return null;
  return problem.server
    ? <p className="setup-error" role="alert">{problem.text}</p>
    : <p className="setup-error" aria-live="polite">{problem.text}</p>;
}

export function ResetPage() {
  const { data, isPending } = useResetConfig();
  const [params] = useSearchParams();
  const hint = cleanSetupHint(params.get('setup'));
  return (
    <div className="setup reset-page">
      <span className="setup-eyebrow">Account help</span>
      <h1>Forgot your password?</h1>
      {isPending && <p className="setup-lede">Loading…</p>}
      {!isPending && !data?.enabled && (
        <div className="reset-card">
          <p className="setup-lede">Password reset is not available on this server.</p>
          <Link className="setup-secondary reset-link-button" to={hint ? `/${hint}` : '/configure'}>Back</Link>
        </div>
      )}
      {data?.enabled && <ResetFlow siteKey={data.siteKey} hint={hint} />}
    </div>
  );
}

interface Tracked { requestId: string; action: ResetAction }
type Stage =
  | { name: 'form' }
  | { name: 'track'; request: Tracked }
  | { name: 'done'; action: ResetAction };

export function ResetFlow({ siteKey, hint }: { siteKey: string; hint: string | null }) {
  const [stage, setStage] = useState<Stage>({ name: 'form' });
  // The setup the person is working on, when the page or the link told us.
  const [setupId, setSetupId] = useState<string | null>(hint);

  if (stage.name === 'form') {
    return (
      <RequestForm
        siteKey={siteKey} hint={hint}
        onRequested={(request, id) => { if (id) setSetupId(id); setStage({ name: 'track', request }); }}
      />
    );
  }
  if (stage.name === 'track') {
    return (
      <TrackRequest
        request={stage.request}
        onRedeemed={(action) => setStage({ name: 'done', action })}
        onRestart={() => setStage({ name: 'form' })}
      />
    );
  }
  return <Finished action={stage.action} setupId={setupId} />;
}

function RequestForm({ siteKey, hint, onRequested }: {
  siteKey: string;
  hint: string | null;
  onRequested: (request: Tracked, setupId: string | null) => void;
}) {
  const [action, setAction] = useState<ResetAction>('reset');
  // Component state only: never Web Storage, never the draft store.
  const [link, setLink] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const check = useTurnstile('reset-request', { siteKey });
  const ready = stepOneReady({ link, key, tokenReady: turnstileReady(check) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setProblem(null);
    const sentLink = link;
    try {
      const result = await submitWithTurnstile(check, (token) => requestReset({
        installToken: sentLink, key, action, turnstile: token,
      }));
      onRequested({ requestId: result.requestId, action: result.action }, setupIdFromLink(sentLink));
      setLink('');
    } catch (error) {
      setProblem(describeFailure(error, 'Could not send the request. Try again.'));
    } finally {
      setKey('');
      setBusy(false);
    }
  }

  return (
    <form className="reset-card" onSubmit={(event) => void submit(event)}>
      <p className="setup-lede">
        There is no email on file, so a person checks every request. Prove the setup is yours, then ask for a one-time code in the LeLibrary Discord server.
      </p>
      <fieldset className="reset-choice">
        <legend>What do you need?</legend>
        <label className={`reset-option${action === 'reset' ? ' is-selected' : ''}`}>
          <input type="radio" name="reset-action" checked={action === 'reset'} onChange={() => setAction('reset')} />
          <span>Reset my password</span>
        </label>
        <label className={`reset-option${action === 'delete' ? ' is-selected' : ''}`}>
          <input type="radio" name="reset-action" checked={action === 'delete'} onChange={() => setAction('delete')} />
          <span>Delete my setup</span>
        </label>
      </fieldset>
      {hint && (
        <label className="setup-field">
          <span>Setup id</span>
          <input className="edit-unlock-id" readOnly value={hint} data-i18n-preserve onFocus={(event) => event.target.select()} />
        </label>
      )}
      <label className="setup-field">
        <span>Your install link (the link you added to Stremio or Nuvio)</span>
        <input
          type="password" autoComplete="off" spellCheck={false} value={link}
          onChange={(event) => setLink(event.target.value)} disabled={busy}
        />
      </label>
      <label className="setup-field">
        <span>One of your saved API keys (for example your TorBox or Real-Debrid key)</span>
        <input
          type="password" autoComplete="off" spellCheck={false} value={key}
          onChange={(event) => setKey(event.target.value)} disabled={busy}
        />
      </label>
      <TurnstileCheck control={check} />
      <ProblemLine problem={problem} />
      <button type="submit" className="setup-primary reset-submit" disabled={busy || !ready}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}

export function TrackRequest({ request, onRedeemed, onRestart }: {
  request: Tracked;
  onRedeemed: (action: ResetAction) => void;
  onRestart: () => void;
}) {
  const [status, setStatus] = useState<ResetStatus | null>(null);
  const stopped = useRef(false);
  const name = status?.status ?? 'waiting_discord';
  const terminal = status ? isTerminalStatus(status.status) : false;
  const action = status?.action ?? request.action;

  useEffect(() => {
    stopped.current = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await fetchResetStatus(request.requestId, controller.signal);
        if (stopped.current) return;
        setStatus(next);
        if (isTerminalStatus(next.status)) return;
      } catch (error) {
        if (stopped.current) return;
        // An unknown id is a dead request; anything else (offline) is retried.
        if (error instanceof ApiError && error.status === 404) {
          setStatus({ status: 'closed', action: request.action, codeExpiresAt: null, expiresAt: '' });
          return;
        }
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => { stopped.current = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [request.requestId, request.action]);

  function copyId() {
    void navigator.clipboard?.writeText(request.requestId).then(
      () => toast('Request id copied'),
      () => toast('Could not copy. Select the id and copy it.', 'error'),
    );
  }

  const dead = name === 'denied' || name === 'closed';
  return (
    <div className="reset-card">
      <p className="setup-lede">
        {action === 'delete'
          ? 'Request received. Follow these steps to delete your setup.'
          : 'Request received. Follow these steps to choose a new password.'}
      </p>
      <div className="reset-id-box">
        <span className="reset-id-label">Your request id</span>
        <code className="reset-id" data-i18n-preserve>{request.requestId}</code>
        <button type="button" className="setup-secondary" onClick={copyId}>Copy</button>
      </div>
      <ol className="reset-steps">
        <li>Open the LeLibrary Discord server, run the /reset command and paste the request id. The id can be linked for 30 minutes.</li>
        <li>The operator approves the request. A one-time code then arrives in your Discord DMs within about a minute, valid for 15 minutes.</li>
        <li>Enter the code below.</li>
      </ol>
      <p className={`reset-status is-${name}`} aria-live="polite">{STATUS_COPY[name]}</p>
      {dead && (
        <button type="button" className="setup-primary reset-submit" onClick={onRestart}>Start again</button>
      )}
      {!dead && !terminal && (
        <RedeemForm requestId={request.requestId} action={action} onRedeemed={onRedeemed} />
      )}
      {name === 'done' && (
        <button type="button" className="setup-primary reset-submit" onClick={onRestart}>Start again</button>
      )}
    </div>
  );
}

export function RedeemForm({ requestId, action, onRedeemed }: {
  requestId: string; action: ResetAction; onRedeemed: (action: ResetAction) => void;
}) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const ready = redeemReady({ action, code, password, confirmation, understood });
  const mismatch = action === 'reset' && (password || confirmation) ? passwordProblem(password, confirmation) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready || !codeComplete(code)) return;
    setBusy(true);
    setProblem(null);
    try {
      await redeemReset(action === 'delete'
        ? { requestId, code, confirmDelete: true }
        : { requestId, code, newPassword: password });
      setPassword('');
      setConfirmation('');
      onRedeemed(action);
    } catch (error) {
      setProblem(describeFailure(error, 'Could not use that code. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="reset-redeem" onSubmit={(event) => void submit(event)}>
      <label className="setup-field">
        <span>One-time code</span>
        <input
          className="reset-code" inputMode="text" autoComplete="one-time-code" autoCapitalize="characters"
          spellCheck={false} placeholder="XXXX-XXXX" value={code} disabled={busy}
          onChange={(event) => setCode(formatCode(event.target.value))}
        />
      </label>
      {action === 'reset' ? (
        <>
          <label className="setup-field">
            <span>New password</span>
            <input
              type="password" autoComplete="new-password" value={password} disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="setup-field">
            <span>Confirm new password</span>
            <input
              type="password" autoComplete="new-password" value={confirmation} disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {mismatch && <p className="setup-error" aria-live="polite">{PASSWORD_PROBLEM_COPY[mismatch]}</p>}
        </>
      ) : (
        <>
          <p className="reset-warning">
            Deleting is permanent. Your setup, its saved keys and its install link are erased and cannot be recovered.
          </p>
          <label className="reset-check">
            <input type="checkbox" checked={understood} disabled={busy} onChange={(event) => setUnderstood(event.target.checked)} />
            <span>I understand this deletes my setup permanently</span>
          </label>
        </>
      )}
      <ProblemLine problem={problem} />
      <button type="submit" className={action === 'delete' ? 'btn-danger reset-submit' : 'setup-primary reset-submit'} disabled={busy || !ready}>
        {busy ? 'Working…' : action === 'delete' ? 'Delete my setup' : 'Change my password'}
      </button>
    </form>
  );
}

function Finished({ action, setupId }: { action: ResetAction; setupId: string | null }) {
  if (action === 'delete') {
    return (
      <div className="reset-card">
        <p className="reset-done" role="status">Your setup was deleted.</p>
        <Link className="setup-secondary reset-link-button" to="/configure">Create a new setup</Link>
      </div>
    );
  }
  return (
    <div className="reset-card">
      <p className="reset-done" role="status">
        Password changed. You were signed out everywhere. Open your setup and sign in with the new password.
      </p>
      {setupId && <Link className="setup-primary reset-link-button" to={`/${setupId}`}>Open my setup</Link>}
    </div>
  );
}
