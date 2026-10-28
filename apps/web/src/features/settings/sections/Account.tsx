// Account: sign out, leave an organization, and delete the account (PRD APP08:
// in-app deletion with the retention explained). Deletion is two steps on the
// server: request_account_deletion leaves every organization and anonymises the
// profile (refused while the person is the last owner of one), then the
// account-delete function removes the sign-in account. If only the first step
// worked, the screen says exactly that and offers to finish it.
import { useState } from 'react';
import { supabase } from '../../../api/client';
import { config } from '../../../config';
import { DekError, toDekError } from '../../../api/errors';
import { api } from '../../../api/rpc';
import type { OrgSummary } from '../../../api/types';
import { brandVars } from '../../../lib/color';
import { actions, resetState, setState } from '../../../store';
import { Banner, Button, ConfirmDialog, Modal, TextField, toast } from '../../../ui/kit';
import { refreshMeEverywhere, refreshShell, useMe } from '../../admin/common/context';
import { ORG_ROLE_LABEL } from '../../admin/common/format';
import { useAction } from '../../admin/common/load';
import { Card, ErrorView, FormError, List, Loading, Pill, Row, Section } from '../../admin/common/ui';

// actions.signOut is the core builder's (it also unregisters this device's push
// subscription and wipes local caches). It refuses with `conflict` while messages
// are still unsent, unless forced. Without it, sign out of Supabase directly.
export async function signOutNow(opts: { force?: boolean } = {}): Promise<void> {
  try {
    await actions.signOut(opts.force ? { force: true } : undefined);
    return;
  } catch (e) {
    if (!(e instanceof Error && /not implemented/.test(e.message))) throw e;
  }
  await supabase().auth.signOut({ scope: 'local' });
  resetState();
  setState((s) => ({ session: { ...s.session, status: 'signed_out', userId: null, email: null } }));
}

export function AccountSection() {
  const { me, status, error, retry } = useMe();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<DekError | null>(null);
  const [leaving, setLeaving] = useState<OrgSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!me) return status === 'error' && error ? <ErrorView error={error} onRetry={retry} what="account" /> : <Loading label="Loading your account" />;

  const onSignOut = async (force = false) => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOutNow({ force });
    } catch (e) {
      setSignOutError(toDekError(e));
      setSigningOut(false);
    }
  };
  const unsent = signOutError?.code === 'conflict';

  return (
    <>
      <Section title="Account">
        <Card>
          <p className="ap-card__text">Signed in as <span className="ap-strong">{me.email}</span>.</p>
          <p className="ap-card__text">Signing out also stops notifications on this device and clears what Dek kept on it.</p>
          {unsent && signOutError ? (
            <Banner tone="warning">
              <span className="ap-strong">You have unsent messages.</span> {signOutError.hint} Wait a moment for them to send, or sign out anyway.
            </Banner>
          ) : (
            <FormError error={signOutError} onRetry={() => { void onSignOut(); }} />
          )}
          <div className="ap-form__actions ap-form__actions--start">
            {unsent
              ? <Button variant="danger" icon="logout" onClick={() => { void onSignOut(true); }} loading={signingOut}>Sign out anyway</Button>
              : <Button icon="logout" onClick={() => { void onSignOut(); }} loading={signingOut}>Sign out</Button>}
            {unsent ? <Button variant="ghost" onClick={() => setSignOutError(null)} disabled={signingOut}>Keep me signed in</Button> : null}
          </div>
        </Card>
      </Section>

      <Section title="Your organizations" description="Leaving an organization removes you from all of its team servers, channels and notifications at once.">
        {me.orgs.length ? (
          <List label="Your organizations">
            {me.orgs.map((o) => (
              <Row
                key={o.id}
                leading={<span className="set-orgmark" style={{ background: brandVars(o.brand_color).org, color: brandVars(o.brand_color).orgFg }} aria-hidden="true">{(o.short_name || o.name).charAt(0).toUpperCase()}</span>}
                title={<><span dir="auto">{o.name}</span><Pill tone={o.my_role === 'owner' || o.my_role === 'admin' ? 'accent' : 'neutral'}>{ORG_ROLE_LABEL[o.my_role]}</Pill></>}
                trailing={<Button variant="ghost" onClick={() => setLeaving(o)}>Leave</Button>}
              />
            ))}
          </List>
        ) : <p className="ap-hint">You are not in any organization.</p>}
      </Section>

      <Section title="Delete account">
        <Card tone="danger">
          <p className="ap-card__text">Deleting your account cannot be undone.</p>
          <ul className="set-list">
            <li><span className="ap-strong">Deleted:</span> your name, handle, title, picture and status; your membership in every organization, team server and channel; your devices and notification settings; your saved messages and the people you blocked; your sign-in account.</li>
            <li><span className="ap-strong">Kept by the organizations:</span> the messages and files you posted stay in their conversations, shown as written by &quot;Deleted user&quot;, because they are part of the team&apos;s shared record. Admin actions you took stay in the audit logs.</li>
            <li>If you are the last owner of an organization, make someone else an owner first.</li>
          </ul>
          <div className="ap-form__actions ap-form__actions--start">
            <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>Delete my account</Button>
          </div>
        </Card>
      </Section>

      {leaving ? <LeaveOrgDialog org={leaving} onClose={() => setLeaving(null)} /> : null}
      {deleting ? <DeleteAccountDialog onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

function LeaveOrgDialog({ org, onClose }: { org: OrgSummary; onClose: () => void }) {
  const act = useAction(() => api.leaveOrg(org.id));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    void refreshMeEverywhere();
    refreshShell();
    toast({ kind: 'success', title: `You left ${org.name}` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Leave ${org.name}?`}
      body={(
        <div className="ap-form">
          <p>You lose every team server, channel and direct message in {org.name} right away. Your messages stay. To come back you need a new invite.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Leave organization"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

type Phase = 'confirm' | 'deleting' | 'finishing' | 'partial' | 'done';

// The account-delete function answers 200 when the account is gone, 401 without a
// valid session, 409 for the last owner of an organization, 500 when a step failed
// (safe to retry: every step is idempotent), 503 when it is not configured. Its
// body carries a human hint, shown as is.
//
// supabase().functions.invoke first. The shared client adds an x-dek-build header
// that the functions' CORS rules do not list, so a browser refuses that request
// before it leaves (it looks like a dropped connection): then the same call goes
// once more as a plain request with only the headers the function allows.
export async function finishDeletion(): Promise<DekError | null> {
  try {
    const { error } = await supabase().functions.invoke('account-delete', { method: 'POST', body: {} });
    if (!error) return null;
    const res = (error as { context?: unknown }).context;
    if (res instanceof Response) return deletionError(res.status, await hintOf(res));
    if ((error as { name?: string }).name !== 'FunctionsFetchError') return deletionError(null, null);
  } catch {
    // fall through to the plain request
  }
  return plainDeletion();
}

async function hintOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { hint?: unknown };
    return typeof body.hint === 'string' ? body.hint : null;
  } catch {
    return null;
  }
}

async function plainDeletion(): Promise<DekError | null> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return deletionError(401, null);
  try {
    const res = await fetch(`${config.supabaseUrl}/functions/v1/account-delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) return null;
    return deletionError(res.status, await hintOf(res));
  } catch {
    return deletionError(null, null);
  }
}

export function deletionError(status: number | null, hint: string | null): DekError {
  if (status === 401) return new DekError('auth_required', hint ?? 'Your session ended before the deletion finished. Sign in again.', status);
  if (status === 409) return new DekError('conflict', hint ?? 'You are the last owner of an organization. Make someone else an owner first.', status);
  if (status === 404) return new DekError('unknown', 'The account deletion service is not on the server yet.', status);
  if (status === 503) return new DekError('server', hint ?? 'Account deletion is not available right now.', status);
  if (status !== null && status >= 500) return new DekError('server', hint ?? 'The account deletion service had a problem.', status);
  if (status === null) return new DekError('network', 'The account deletion service could not be reached.', null);
  return new DekError('unknown', hint ?? 'Account deletion did not finish.', status);
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('confirm');
  const [error, setError] = useState<DekError | null>(null);
  const ready = typed.trim() === 'DELETE';

  const finish = async () => {
    setPhase('finishing');
    setError(null);
    const problem = await finishDeletion();
    if (problem) {
      setError(problem);
      setPhase('partial');
      return;
    }
    setPhase('done');
    toast({ kind: 'success', title: 'Your account was deleted' });
    try {
      await signOutNow({ force: true });
    } catch {
      // the account is gone; the next request signs the browser out anyway
    }
  };
  const start = async () => {
    if (!ready) return;
    setPhase('deleting');
    setError(null);
    try {
      await api.requestAccountDeletion();
    } catch (e) {
      setError(toDekError(e));
      setPhase('confirm');
      return;
    }
    await finish();
  };

  const busy = phase === 'deleting' || phase === 'finishing';
  const blocked = phase === 'confirm' && error?.code === 'conflict';

  if (phase === 'partial' || phase === 'done') {
    return (
      <Modal open size="sm" title={phase === 'done' ? 'Account deleted' : 'Almost done'} onClose={() => undefined} dismissable={false}
        footer={phase === 'partial' ? (
          <>
            <Button variant="ghost" onClick={() => { void signOutNow({ force: true }); }}>Sign out</Button>
            <Button variant="primary" onClick={finish}>Try again</Button>
          </>
        ) : undefined}>
        {phase === 'done' ? (
          <p className="ap-card__text">Your account is deleted. Signing you out.</p>
        ) : (
          <div className="ap-form">
            <p className="ap-card__text">Your profile, memberships and devices are deleted, and nobody can see your account any more.</p>
            <Banner tone="warning">Removing your sign-in account did not finish: {error?.hint ?? 'unknown problem'}</Banner>
            <p className="ap-card__text">Try again now, or sign out: an organization admin can ask the Dek operators to finish it.</p>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal open size="sm" title="Delete your account?" onClose={onClose} dismissable={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={start} loading={busy} disabled={!ready || blocked}>Delete account</Button>
        </>
      )}>
      <form className="ap-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <p className="ap-card__text">This removes you from every organization and deletes your profile and sign-in account. Your messages stay, shown as &quot;Deleted user&quot;. It cannot be undone.</p>
        {blocked && error ? (
          <Banner tone="danger">{error.hint} Go to Admin, Members in that organization to make someone an owner.</Banner>
        ) : (
          <FormError error={error} onRetry={start} />
        )}
        <TextField
          label="Type DELETE to confirm"
          value={typed}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => { setTyped(e.target.value); if (blocked) setError(null); }}
        />
      </form>
    </Modal>
  );
}
