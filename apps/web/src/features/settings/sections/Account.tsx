// Account: sign out, leave an organization, and delete the account (PRD APP08:
// in-app deletion with the retention explained). Deletion is two steps on the
// server: request_account_deletion leaves every organization and anonymises the
// profile (refused while the person is the last owner of one), then the
// account-delete function removes the sign-in account. If only the first step
// worked, the screen says exactly that and offers to finish it.
import { useState } from 'react';
import { supabase } from '../../../api/client';
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
// subscription and wipes local caches). Without it, sign out of Supabase directly.
export async function signOutNow(): Promise<void> {
  try {
    await actions.signOut();
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

  const onSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOutNow();
    } catch (e) {
      setSignOutError(toDekError(e));
      setSigningOut(false);
    }
  };

  return (
    <>
      <Section title="Account">
        <Card>
          <p className="ap-card__text">Signed in as <span className="ap-strong">{me.email}</span>.</p>
          <p className="ap-card__text">Signing out also stops notifications on this device and clears what Dek kept on it.</p>
          <FormError error={signOutError} onRetry={onSignOut} />
          <div className="ap-form__actions ap-form__actions--start">
            <Button icon="logout" onClick={onSignOut} loading={signingOut}>Sign out</Button>
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

async function finishDeletion(): Promise<DekError | null> {
  try {
    const { error } = await supabase().functions.invoke('account-delete', { method: 'POST', body: {} });
    if (!error) return null;
    const ctx = (error as { context?: { status?: number } }).context;
    const status = typeof ctx?.status === 'number' ? ctx.status : null;
    if (status === 404) return new DekError('unknown', 'The account deletion service is not available on the server yet.', 404);
    if (status !== null && status >= 500) return new DekError('server', 'The account deletion service had a problem.', status);
    if (status === 401) return new DekError('auth_required', 'Your session ended before the deletion finished.', status);
    return new DekError('network', 'The account deletion service could not be reached.', status);
  } catch (e) {
    return toDekError(e);
  }
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
      await signOutNow();
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
            <Button variant="ghost" onClick={() => { void signOutNow(); }}>Sign out</Button>
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
