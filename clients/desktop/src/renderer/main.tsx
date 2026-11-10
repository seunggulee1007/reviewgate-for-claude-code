/** Renderer entry: i18n from the OS locale, then `<App />` (the `--e2e` script attaches itself in App). */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initI18n } from "./i18n";
import { keepQueueAcrossReloads } from "./sessionKeep";
import { useStore } from "./store";
import { notifyWhenAgentsFinish } from "./agentUi";
import { installAutoTitle } from "./autoTitle";
import "./styles.css";

initI18n(window.rg.locale, window.rg.platform);
// MARK: polish p-ui-kit — PX-09: text cut short with an ellipsis reads in full on hover (one listener for the page).
installAutoTitle(document);
// polish-03: the message queue is kept per project (localStorage, p-lifecycle P4-composer-07) and comes back paused.
keepQueueAcrossReloads(useStore);
// MARK: wave3 desktop-agents — §36.4: one OS notification per turn when the subagents the main turn waited on have all finished.
notifyWhenAgentsFinish(useStore);
// Errors outside React's render (event handlers, promises) go to the main log too.
window.addEventListener("error", (e) => void window.rg.logError(`window error: ${e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message}`).catch(() => undefined));
window.addEventListener("unhandledrejection", (e) => void window.rg.logError(`unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`).catch(() => undefined));
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary name="App" className="app-shell">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
