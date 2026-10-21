import type { Snapshot } from "./conversation.js";

export function EvidencePanel({ state, mock }: { state: Snapshot; mock: boolean }) {
  return <aside className="evidence-panel" aria-labelledby="evidence-title">
    <div className="section-heading"><div><span className="eyebrow">THE SOURCE OF TRUTH</span><h2 id="evidence-title">Evidence</h2></div>
      <span className="count" aria-label={`${state.evidence.length} verified sources`}>{state.evidence.length.toString().padStart(2, "0")}</span></div>
    <p className="section-description">{mock ? "Simulated verification of approved synthetic excerpts." : "Source excerpts independently checked by the local data room."}</p>
    <div className="evidence-content" aria-live="polite" aria-busy={state.evidenceState === "checking"}>
      {state.evidenceState === "checking" && <div className="empty-evidence"><span className="document-icon" aria-hidden="true">≡</span><h3>Checking the sources</h3><p>Matching the excerpt to its document.</p></div>}
      {!state.evidence.length && state.evidenceState !== "checking" && <div className="empty-evidence"><span className="document-icon" aria-hidden="true">≡</span>
        <h3>No verified citations for this answer</h3><p>Verified excerpts will appear here when a source supports the conversation.</p></div>}
      {state.evidence.map((item, index) => <article className="evidence-card" data-testid="verified-citation" key={`${item.chunk_id}-${index}`}>
        <div className="card-heading"><span className="source-number">{String(index + 1).padStart(2, "0")}</span><span className="verified-badge">✓ {mock ? "Verified in mock" : "Verified source"}</span></div>
        <h3>{item.document}</h3><p className="source-location">{item.section_title || "Source location unavailable"}</p>
        <blockquote>{item.quote}</blockquote><p className="source-note">Synthetic text document · No PDF page number</p>
      </article>)}
      {state.rejected > 0 && <p className="rejected-note">{state.rejected} unsupported {state.rejected === 1 ? "citation" : "citations"} withheld.</p>}
    </div>
    <div className="evidence-footer"><span aria-hidden="true">◇</span><p>A fluent answer is not proof.<br />Use the source to assess every claim.</p></div>
  </aside>;
}
