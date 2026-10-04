// The last line of defence: a render error anywhere below shows this screen instead of
// unmounting the whole app to a white page (and a reload landing on the same broken
// address). The person can reload or go to the home screen; nothing they typed in the
// composer is lost, because drafts and unsent messages live in the store, not in React.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { failed: boolean; at: string | null }

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { failed: false, at: null };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The message and component stack only: never user content.
    console.error('[dek] screen crashed:', error.name, error.message, info.componentStack?.split('\n').slice(0, 6).join('\n'));
    this.setState({ at: typeof window === 'undefined' ? null : window.location.pathname });
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    // Navigating somewhere else clears the error, so one broken screen does not trap the app.
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, at: null });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="dk-center" role="alert" style={{ flexDirection: 'column', gap: 12, padding: 24, textAlign: 'center', minHeight: '60vh' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong on this screen</h1>
        <p style={{ margin: 0, maxWidth: 420 }}>
          Your messages and drafts are safe. Reload to try again, or go back to your conversations.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" className="dk-btn dk-btn--primary dk-btn--md" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" className="dk-btn dk-btn--secondary dk-btn--md" onClick={() => window.location.assign('/')}>Go to home</button>
        </div>
      </div>
    );
  }
}
