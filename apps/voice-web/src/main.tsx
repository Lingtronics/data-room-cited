import { Component, lazy, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { isLocalPage, type WebConfig } from "./config.js";
import "./styles.css";
declare const __VOICE_WEB_CONFIG__: WebConfig;
const MockApp = lazy(() => import("./MockApp.js"));
const LiveApp = lazy(() => import("./LiveApp.js"));
class SafeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="unavailable"><h1>Voice research is unavailable</h1><p>Close this tab before trying again. The text workspace remains available.</p><a href="http://localhost:8501">Open text workspace</a></div> : this.props.children; }
}
const config = __VOICE_WEB_CONFIG__;
createRoot(document.getElementById("root")!, { onCaughtError: () => {}, onUncaughtError: () => {}, onRecoverableError: () => {} }).render(<SafeBoundary>
  {!config.enabled || !isLocalPage(window.location) ? <div className="unavailable"><h1>Voice research is disabled</h1><p>Use the approved local demo setup to enable this workspace.</p><a href="http://localhost:8501">Open text workspace</a></div> :
    <Suspense fallback={<p className="unavailable" role="status">Preparing the research workspace…</p>}>
      {config.mode === "mock" ? <MockApp config={config} /> : <LiveApp config={config} />}
    </Suspense>}
</SafeBoundary>);
