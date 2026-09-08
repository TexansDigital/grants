/**
 * The last thing between a bad payload and a blank page.
 *
 * Without this, a response of the wrong shape threw during render and React
 * unmounted the whole tree: no text, no controls, no way back. For an applicant
 * an hour into a form, everything visibly disappeared with no explanation --
 * which is indistinguishable from the application having lost their work.
 *
 * A class component because that is the only thing React gives us for this.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Nothing to report to yet -- there is no client error endpoint. Logged so
    // a staff member reading the console can quote something useful.
    console.error('Steward render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="state" role="alert">
        <h1>Something went wrong on this page</h1>
        <p>
          The page could not be displayed. Nothing you have entered has been sent, and any
          draft saved in this browser is still there.
        </p>
        <p>
          <code>{this.state.error.message}</code>
        </p>
        <p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </p>
      </div>
    );
  }
}
