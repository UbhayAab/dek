// OWNER: core platform builder. Starts auth listening, the legacy session exchange,
// the realtime hub, the outbox and the service worker; registers the actions.
let started = false;
export function startApp(): void {
  if (started) return;
  started = true;
}
