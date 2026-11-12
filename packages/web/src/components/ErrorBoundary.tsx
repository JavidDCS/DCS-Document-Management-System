import { AlertTriangle, Copy, Check, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, copied: false };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console without leaking to remote services unless configured
    console.error('Unhandled UI exception in component tree:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, copied: false });
  };

  handleReload = () => {
    window.location.reload();
  };

  handleCopy = async () => {
    const err = this.state.error;
    const text = `Error: ${err?.name ?? 'Unknown'}\nMessage: ${err?.message ?? 'No details'}\nStack:\n${err?.stack ?? 'N/A'}\nURL: ${window.location.href}\nTime: ${new Date().toISOString()}`;
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // Fallback ignore
    }
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const err = this.state.error;
      const incidentId = `err_${Date.now().toString(36)}`;

      return (
        <div className="min-h-[420px] p-6 sm:p-12 flex items-center justify-center">
          <div className="card max-w-xl w-full border-danger/30 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
                <AlertTriangle className="size-6" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-foreground tracking-tight">Something went wrong</h2>
                <p className="muted mt-1 text-sm">
                  An unexpected error occurred in this view. Your session data and documents are safe.
                </p>

                <div className="mt-4 rounded-lg bg-muted/60 p-3 font-mono text-xs text-foreground/80 break-words">
                  <div className="flex items-center justify-between text-muted-foreground pb-1 mb-1 border-b border-border/50">
                    <span>Incident ID: <strong className="text-foreground">{incidentId}</strong></span>
                    <button
                      type="button"
                      onClick={this.handleCopy}
                      className="inline-flex items-center gap-1 text-[11px] font-sans hover:text-foreground"
                    >
                      {this.state.copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                      {this.state.copied ? 'Copied' : 'Copy report'}
                    </button>
                  </div>
                  <p className="font-semibold text-danger">{err?.name || 'Error'}: {err?.message || 'Unknown runtime error'}</p>
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <button type="button" className="btn primary" onClick={this.handleReset}>
                    <RefreshCw className="size-3.5" /> Try again
                  </button>
                  <button type="button" className="btn" onClick={this.handleReload}>
                    Reload page
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

