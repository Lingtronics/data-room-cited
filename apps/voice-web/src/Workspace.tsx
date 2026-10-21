import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { ConversationController, type Phase } from "./conversation.js";
import { errorMessages } from "./errors.js";
import { EvidencePanel } from "./EvidencePanel.js";
import { Transcript } from "./Transcript.js";
import type { Scenario } from "./mock.js";

const phases: Record<Phase, string> = { idle: "Ready when you are", requesting_permission: "Waiting for microphone permission",
  connecting: "Connecting", listening: "Listening", agent_speaking: "Assistant speaking", disconnecting: "Ending conversation", error: "Conversation needs attention" };
export function Workspace({ controller, mock, maxMinutes, scenario, onScenario }: {
  controller: ConversationController; mock: boolean; maxMinutes: number; scenario?: Scenario; onScenario?: (value: Scenario) => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [kind, setKind] = useState<"voice" | "text">("voice");
  const [input, setInput] = useState("");
  const active = !["idle", "error"].includes(state.phase);
  const connected = ["listening", "agent_speaking"].includes(state.phase);
  useEffect(() => {
    const pagehide = () => { void controller.end(); };
    window.addEventListener("pagehide", pagehide);
    return () => { window.removeEventListener("pagehide", pagehide); controller.dispose(); };
  }, [controller]);
  useEffect(() => { if (!connected) setInput(""); }, [connected]);
  const submit = (event: FormEvent) => { event.preventDefault(); controller.send(input); setInput(""); };
  let status = phases[state.phase];
  if (mock && state.phase === "requesting_permission") status = "Preparing the mock conversation";
  if (state.kind === "text" && state.phase === "listening") status = "Ready for your message";
  if (mock && state.phase === "listening") status = "Demo ready";

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Data Room Cited home"><span className="brand-mark" aria-hidden="true">c<span>·</span></span>Data Room <strong>Cited</strong></a>
      <div className="header-links"><span className="scope-badge"><span aria-hidden="true">●</span> SYNTHETIC DATA ONLY</span><a href="http://localhost:8501" className="text-link">Text workspace <span aria-hidden="true">↗</span></a></div></header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">RESEARCH WORKSPACE <span>/</span> VOICE</div><h1>Ask. Listen. <em>Verify.</em></h1>
        <p>Explore the data room in conversation. Keep the evidence in view.</p></div><span className="read-only">◇ Read-only workspace</span></div>
      <div className={`mode-notice ${mock ? "mock-notice" : "live-notice"}`}><span className="notice-label">{mock ? "MOCK DEMO" : "LIVE PROVIDER MODE"}</span>
        <p>{mock ? "A scripted conversation with simulated verification. No microphone, credentials or provider connection." : "ElevenLabs processes your audio and conversation content. Only approved synthetic documents are available. Provider retention settings apply."}</p></div>
      <div className="workspace-grid"><section className="conversation-panel" aria-labelledby="voice-title">
        <div className="section-heading"><div><span className="eyebrow">A CONVERSATION WITH CONTEXT</span><h2 id="voice-title">Voice research</h2></div><span className="session-tag">LOCAL DEMO</span></div>
        <div className={`voice-stage phase-${state.phase}`}>
          <div className="voice-orb" aria-hidden="true"><div className="orb-core"><span /><span /><span /><span /><span /></div></div>
          <div className="phase-label" role="status" aria-live="polite"><span className={`status-dot ${connected ? "connected" : ""}`} aria-hidden="true" />{status}</div>
          <p className="stage-hint">{active ? mock ? "Watch the transcript and the source check below." : kind === "voice" ? "Speak naturally. You can interrupt the assistant." : "Type a question below." : "Start with a question. Follow it back to the source."}</p>
          <fieldset className="conversation-kind" disabled={active}><legend className="sr-only">Conversation format</legend>
            <label><input type="radio" name="kind" value="voice" checked={kind === "voice"} onChange={() => setKind("voice")} />Voice</label>
            <label><input type="radio" name="kind" value="text" checked={kind === "text"} onChange={() => setKind("text")} />Text only</label></fieldset>
          <div className="main-actions">{active ? <button className="button button-end" onClick={() => { void controller.end(); }} disabled={state.phase === "disconnecting"}><span aria-hidden="true">■</span> {state.phase === "connecting" || state.phase === "requesting_permission" ? "Cancel connection" : "End conversation"}</button> :
            <button className="button button-primary" disabled={!state.canRetry} onClick={() => { void controller.start(kind); }}><span aria-hidden="true">{kind === "voice" ? "◉" : "↵"}</span> {state.phase === "error" ? "Try again" : mock ? "Start mock demo" : kind === "voice" ? "Start voice" : "Start text"}</button>}</div>
          <p className="consent-note">{mock ? "No microphone will be requested." : kind === "voice" ? "Starting requests microphone permission and connects to ElevenLabs." : "Starting sends your typed conversation to ElevenLabs. No microphone is used."} <span>Up to {maxMinutes} minutes per session.</span></p>
        </div>
        {mock && <div className="scenario-control"><label htmlFor="scenario">Demo scenario</label><select id="scenario" value={scenario} disabled={active} onChange={event => onScenario?.(event.target.value as Scenario)}>
          <option value="supported">Supported claim + rejected citation</option><option value="unsupported">Insufficient evidence</option><option value="unavailable">Evidence service unavailable</option></select></div>}
        {state.error && <div className="error-notice" role="alert"><strong>{state.error === "mcp_unavailable" ? "Evidence unavailable" : "Something needs attention"}</strong><p>{errorMessages[state.error]}</p></div>}
        {state.notice && <p className="session-notice" role="status">{state.notice}</p>}
        <Transcript messages={state.transcript} mock={mock} textOnly={state.kind === "text"} />
        {state.kind === "text" && connected && <form className="text-composer" onSubmit={submit}><label htmlFor="message" className="sr-only">Your message</label><input id="message" maxLength={2000} value={input} onChange={event => setInput(event.target.value)} placeholder="Ask about the synthetic sources…" autoComplete="off" /><button className="button button-small" disabled={!input.trim()} type="submit">Send</button></form>}
      </section><EvidencePanel state={state} mock={mock} /></div>
      <div className="workspace-footer"><p><span aria-hidden="true">↳</span> Try asking: “Which contracts have automatic renewal risk?”</p><p>Exact year filtering is unavailable.</p></div>
    </main><footer className="bottom-bar"><span>DATA ROOM CITED</span><p>Conversation is a starting point. Evidence is the reference.</p><span>LOCAL · READ ONLY</span></footer>
  </div>;
}
