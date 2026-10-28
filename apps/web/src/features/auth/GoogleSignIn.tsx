import { useSyncExternalStore } from 'react';
import { cancelGoogle, googleSnapshot, startGoogle, subscribeGoogle } from '../../sync/google';
import { Banner, Button } from '../../ui/kit';

export function GoogleSignIn() {
  const { busy, message } = useSyncExternalStore(subscribeGoogle, googleSnapshot);
  return <div className="dk-auth__form">
    <Button type="button" variant="secondary" size="lg" block loading={busy} onClick={() => { void startGoogle(); }}>Continue with Google</Button>
    {busy ? <button type="button" className="dk-auth__link" onClick={() => { void cancelGoogle(); }}>Cancel Google sign-in</button> : null}
    {message ? <Banner tone="warning">{message}</Banner> : null}
  </div>;
}
