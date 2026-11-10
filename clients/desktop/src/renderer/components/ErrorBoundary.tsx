/**
 * A render error stays inside the pane it happened in (docs/M11-WINDOWS.md): the pane shows
 * "화면 오류가 발생했습니다" with Redraw (remounts the pane) and Copy log (error + component stack to
 * the clipboard); the error also goes to the main process log (`rg:logError`). The rest of the
 * window — and the engine — keep running.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

type Props = { name: string; className?: string; children: ReactNode };
type State = { error: Error | null; stack: string; generation: number; copied: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "", generation: 0, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)), copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = info.componentStack ?? "";
    this.setState({ stack });
    const e = error instanceof Error ? error : new Error(String(error));
    void window.rg?.logError?.(`[${this.props.name}] ${e.stack ?? e.message}\ncomponent stack:${stack}`).catch(() => undefined);
  }

  private report(): string {
    const e = this.state.error;
    return [`ReviewGate — ${this.props.name}`, new Date().toISOString(), e?.stack ?? e?.message ?? "", "component stack:" + this.state.stack].join("\n");
  }

  render(): ReactNode {
    if (!this.state.error) return <Keyed key={this.state.generation}>{this.props.children}</Keyed>;
    return (
      <div className={`${this.props.className ?? ""} error-boundary`} role="alert" data-testid={`${this.props.name} error`}>
        <div className="empty grow">
          <div className="glyph">⚠︎</div>
          <h2>{t("Something went wrong on this screen")}</h2>
          <div className="caption muted mono truncate" style={{ maxWidth: "90%" }} title={this.state.error.message}>{this.state.error.message}</div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="primary" onClick={() => this.setState((s) => ({ error: null, stack: "", generation: s.generation + 1 }))} data-testid={`${this.props.name} redraw`}>
              {t("Redraw")}
            </button>
            <button type="button" onClick={() => void window.rg.copyText(this.report()).then(() => this.setState({ copied: true }))}>
              {this.state.copied ? t("Copied") : t("Copy log")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** Wrapper whose `key` changes on Redraw, so the pane's subtree mounts fresh. */
function Keyed({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
