import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { isOwnerApiError, type CardSyncOwnerClient } from './ownerClient';
import { SyncDialog } from './SyncDialog';
import { errorText, type ErrorText } from './syncText';

export class ActionCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ActionCancelled';
  }
}

interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

interface OwnerActions {
  /**
   * Runs an owner call. When Holdr asks for the password again
   * (`recent-auth-required`), asks for it, and runs the call once more.
   * Rejects with ActionCancelled if the owner closes the password dialog.
   */
  run: <T>(action: () => Promise<T>) => Promise<T>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const Context = createContext<OwnerActions | null>(null);

export function useOwnerActions(): OwnerActions {
  const value = useContext(Context);
  if (!value) throw new Error('useOwnerActions outside OwnerActionsProvider');
  return value;
}

export function OwnerActionsProvider({ client, children }: { client: CardSyncOwnerClient | null; children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmOptions | null>(null);
  const passwordWaiter = useRef<((ok: boolean) => void) | null>(null);
  const confirmWaiter = useRef<((ok: boolean) => void) | null>(null);

  const askPassword = useCallback(() => new Promise<boolean>((resolve) => {
    passwordWaiter.current = resolve;
    setAsking(true);
  }), []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (!isOwnerApiError(error, 'recent-auth-required')) throw error;
      if (!(await askPassword())) throw new ActionCancelled();
      return action();
    }
  }, [askPassword]);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    confirmWaiter.current = resolve;
    setConfirming(options);
  }), []);

  const finishPassword = (ok: boolean) => {
    setAsking(false);
    passwordWaiter.current?.(ok);
    passwordWaiter.current = null;
  };
  const finishConfirm = (ok: boolean) => {
    setConfirming(null);
    confirmWaiter.current?.(ok);
    confirmWaiter.current = null;
  };

  const value = useMemo(() => ({ run, confirm }), [run, confirm]);
  return (
    <Context.Provider value={value}>
      {children}
      {asking && client ? <RecentAuthDialog client={client} onDone={finishPassword} /> : null}
      {confirming ? (
        <SyncDialog title={confirming.title} onClose={() => finishConfirm(false)}>
          <p className="sync-text">{confirming.body}</p>
          <div className="spending-detail-actions">
            <button type="button" className={`spending-button primary${confirming.danger ? ' danger' : ''}`} onClick={() => finishConfirm(true)}>
              {confirming.confirmLabel}
            </button>
            <button type="button" className="spending-button" onClick={() => finishConfirm(false)}>Cancel</button>
          </div>
        </SyncDialog>
      ) : null}
    </Context.Provider>
  );
}

/** Holdr's recent-auth check (proposal Q2): the password is typed, sent once, and cleared. */
function RecentAuthDialog({ client, onDone }: { client: CardSyncOwnerClient; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setProblem(null);
    const typed = password;
    setPassword('');
    try {
      await client.confirmPassword(typed);
      onDone(true);
    } catch (error) {
      // R6: a wrong password is 403 `unauthorized`. A 401 always means the sign-in itself ended, whatever its body says.
      if (isOwnerApiError(error) && error.status === 403 && error.code === 'unauthorized') setProblem('That password didn\'t work. Try again.');
      else if (isOwnerApiError(error) && error.status !== 401 && (error.status === 404 || error.kind === 'unavailable')) {
        setProblem('This Holdr can\'t check your password here yet, so this action isn\'t available.');
      } else setProblem(`${errorText(error).message} ${errorText(error).next}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SyncDialog title="Confirm it's you" onClose={() => onDone(false)} busy={busy}>
      <p className="sync-text">
        Holdr asks for your password again before it pairs a browser, approves one, confirms cards, turns an issuer on, resumes syncing,
        turns on automatic sending or repairs where a charge came from. It isn&apos;t kept on this page.
      </p>
      <form className="spending-detail-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label>
          Holdr password
          <input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {problem ? <div className="spending-error" role="alert">{problem}</div> : null}
        <div className="spending-detail-actions">
          <button type="submit" className="spending-button primary" disabled={busy || !password}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" className="spending-button" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
        </div>
      </form>
    </SyncDialog>
  );
}

/**
 * Busy flag and the last failure's text for one control; ActionCancelled is not a failure. `explain` may give a failure a text
 * of its own where the control knows more than the code does.
 */
export function useActionStatus() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; next: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const track = useCallback(async <T,>(
    work: () => Promise<T>,
    success?: string,
    explain?: (error: unknown) => ErrorText | null,
  ): Promise<T | undefined> => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const result = await work();
      if (success) setDone(success);
      return result;
    } catch (error) {
      if (!(error instanceof ActionCancelled)) setProblem(explain?.(error) ?? errorText(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, problem, done, track, clear: () => { setProblem(null); setDone(null); } };
}

export function ActionProblem({ problem }: { problem: { message: string; next: string } | null }) {
  if (!problem) return null;
  return (
    <div className="spending-error" role="alert">
      <strong>{problem.message}</strong> {problem.next}
    </div>
  );
}
