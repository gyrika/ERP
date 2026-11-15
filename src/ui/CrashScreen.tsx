import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line: if a screen fails to draw, the counter shows this instead of an empty window
 * (the installed app has no address bar and no DevTools, 2026-11-15). One action, Reload, and the
 * error's own words for whoever supports the shop over AnyDesk. Nothing is lost: orders are events.
 */
export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The screen failed to draw:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="lock" aria-label="Something went wrong">
        <div className="lock__card">
          <span className="brand">CheesyBeez</span>
          <h1 className="lock__title">This screen could not open</h1>
          <p className="crash__why">{error.message}</p>
          {/* autoFocus: Enter reloads, keyboard first. */}
          <button type="button" className="cta crash__cta" autoFocus onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}
