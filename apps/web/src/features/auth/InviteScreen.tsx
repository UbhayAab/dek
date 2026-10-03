// The invite landing (/invite/<code>). preview_invite works signed out, so a
// person sees whose organization they are joining before anything else. Signed
// out: sign in, or create an account with an email code, then accept. Signed in:
// Accept; joined goes to the organization, pending waits for an admin, an invalid
// invite says why and offers a way home.
import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../../api/rpc';
import { humanError, toDekError } from '../../api/errors';
import type { InvitePreview } from '../../api/types';
import { navigate } from '../../app/router';
import { brandVars, normalizeHex } from '../../lib/color';
import { actions, useDek } from '../../store';
import { Banner, Button, EmptyState, ErrorState, Spinner } from '../../ui/kit';
import { SetPasswordForm, SignInFlow } from './forms';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; preview: InvitePreview };

type Accept =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'pending' }
  | { state: 'error'; message: string };

const REASONS: Record<NonNullable<InvitePreview['reason']>, string> = {
  expired: 'This invite has expired. Ask the person who sent it for a new link.',
  revoked: 'This invite was withdrawn. Ask the person who sent it for a new link.',
  used_up: 'This invite has already been used as many times as it allows. Ask for a new link.',
  not_found: 'This invite link is not valid. Check that you opened the whole link.',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '')).toUpperCase();
}

export function InviteScreen({ code }: { code: string }) {
  const status = useDek((s) => s.session.status);
  const setup = useDek((s) => s.session.setup);
  const email = useDek((s) => s.session.email);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [accept, setAccept] = useState<Accept>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    api.previewInvite(code)
      .then((preview) => { if (live) setLoad({ state: 'ready', preview }); })
      .catch((e: unknown) => { if (live) setLoad({ state: 'error', message: humanError(e) }); });
    return () => { live = false; };
  }, [code, attempt]);

  const onAccept = async () => {
    if (accept.state === 'busy') return;
    setAccept({ state: 'busy' });
    try {
      const r = await api.acceptInvite(code);
      if (r.status === 'pending') {
        setAccept({ state: 'pending' });
        return;
      }
      await actions.refreshMe();
      await actions.selectOrg(r.org_id);
      navigate({ name: 'org', orgId: r.org_id }, { replace: true });
    } catch (e) {
      const err = toDekError(e);
      setAccept({ state: 'error', message: err.code === 'not_found' ? REASONS.not_found : err.hint });
    }
  };

  const goHome = () => navigate({ name: 'home' }, { replace: true });

  let body;
  if (load.state === 'loading') {
    body = <div className="dk-invite__center" role="status"><Spinner size={24} /><span>Checking your invite</span></div>;
  } else if (load.state === 'error') {
    body = <ErrorState title="We could not check this invite" body={load.message} onRetry={() => setAttempt((n) => n + 1)} />;
  } else if (!load.preview.valid) {
    body = (
      <EmptyState
        icon="alert"
        title="This invite cannot be used"
        body={REASONS[load.preview.reason ?? 'not_found']}
        action={<Button variant="primary" onClick={goHome}>Go to Dek</Button>}
      />
    );
  } else {
    const p = load.preview;
    const color = normalizeHex(p.org_brand_color);
    const vars = color ? brandVars(color) : null;
    const style = vars ? ({ '--invite-color': vars.org, '--invite-fg': vars.orgFg } as CSSProperties) : undefined;
    const orgName = p.org_name ?? 'an organization';
    let action;
    if (status === 'unknown') {
      action = <div className="dk-invite__center" role="status"><Spinner size={20} /></div>;
    } else if (setup) {
      action = <SetPasswordForm mode={setup} email={email} />;
    } else if (status === 'signed_out') {
      action = (
        <SignInFlow
          heading="Sign in to accept"
          lead="Already on Dek? Sign in. New here? Choose Email me a sign-in code to create your account."
        />
      );
    } else if (accept.state === 'pending') {
      action = (
        <>
          <Banner tone="info">Waiting for an admin to approve. You will see {orgName} in Dek once they do.</Banner>
          <Button variant="secondary" block onClick={goHome}>Go to Dek</Button>
        </>
      );
    } else {
      action = (
        <>
          {accept.state === 'error' ? <Banner tone="danger">{accept.message}</Banner> : null}
          <Button variant="primary" size="lg" block loading={accept.state === 'busy'} onClick={() => void onAccept()}>
            {p.requires_approval ? 'Ask to join' : `Join ${orgName}`}
          </Button>
          <p className="dk-invite__meta">Signed in as {email ?? 'you'}.{' '}
            <button type="button" className="dk-auth__link" onClick={() => void actions.signOut()}>Not you? Sign out</button>
          </p>
        </>
      );
    }
    body = (
      <>
        <div className="dk-invite__org" style={style}>
          <span className="dk-invite__swatch" aria-hidden="true">{initials(orgName)}</span>
          <div>
            <p className="dk-invite__meta">You are invited to</p>
            <h1 className="dk-invite__name" dir="auto">{orgName}</h1>
          </div>
        </div>
        <p className="dk-auth__lead" dir="auto">
          {p.inviter_name ? `${p.inviter_name} invited you` : 'You were invited'}
          {p.server_name ? ` to the ${p.server_name} team` : ''}.
          {p.requires_approval ? ' An admin approves new members before they can read anything.' : ''}
        </p>
        <div className="dk-invite__panel">{action}</div>
      </>
    );
  }

  return (
    <main className="dk-auth">
      <div className="dk-auth__card">
        <div className="dk-auth__brand" aria-hidden="true">Dek</div>
        {body}
      </div>
    </main>
  );
}
