// A pane's error boundary (PST-T-14.3): before it, one thrown error anywhere — the search bug the
// design audit found — unmounted the whole app and left a blank page. Now the pane that failed says
// so, with a way to try again, and the sidebar, the account menu and every other place still work.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button } from '@d3cloud/ui';

interface Props {
  /** Names the pane in the message: "The page", "Navigation". */
  name: string;
  /** Changing it clears a caught error — the pathname, so navigating away recovers. */
  resetKey: string;
  children?: ReactNode;
}

interface State {
  failed: boolean;
  resetKey: string;
}

export class PaneBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Kept in the console for whoever opens devtools; nothing is sent anywhere.
    console.error(`[postroom] ${this.props.name} failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="pr-pane-error">
        <Alert
          tone="danger"
          title={`${this.props.name} stopped working`}
          actions={
            <Button
              size="sm"
              onClick={() => {
                this.setState({ failed: false });
              }}
            >
              Try again
            </Button>
          }
        >
          Something in this part of Postroom went wrong. The rest of the app still works — use the navigation to go elsewhere, or try again.
        </Alert>
      </div>
    );
  }
}
