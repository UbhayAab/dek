// OWNER: core platform builder. Sign in, email code, set password, invite landing.
import { currentRoute, navigate } from '../../app/router';
import { useDek } from '../../store';
import { SetPasswordForm, SignInFlow } from './forms';
import './auth.css';

export { InviteScreen } from './InviteScreen';

export function AuthScreen({ next }: { next: string | null }) {
  const setup = useDek((s) => s.session.setup);
  const email = useDek((s) => s.session.email);

  // After signing in, go where the person was headed (only same-app paths reach
  // here: router.safeNext), or leave /signin for the home route.
  const onSignedIn = () => {
    if (next) navigate(next, { replace: true });
    else if (currentRoute().name === 'signin') navigate({ name: 'home' }, { replace: true });
  };

  return (
    <main className="dk-auth">
      <div className="dk-auth__card">
        <div className="dk-auth__brand" aria-hidden="true">Dek</div>
        {setup ? <SetPasswordForm mode={setup} email={email} /> : <SignInFlow onSignedIn={onSignedIn} />}
      </div>
      <p className="dk-auth__foot">
        Team chat for Jarurat Care Foundation and Safalta Setu. <a href="/privacy.html">Privacy</a>
      </p>
    </main>
  );
}
