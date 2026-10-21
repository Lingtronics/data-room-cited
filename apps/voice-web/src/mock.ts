import type { Broker, Session } from "./api.js";
import type { Evidence, EvidenceResult } from "@data-room-cited/voice-api/contracts";
import type { ConversationEvents, Driver } from "./conversation.js";
import { UiError } from "./errors.js";

// Fixed synthetic responses for a labelled UI simulation, not retrieval logic.
export const demoItem = { chunk_id: "voice-contracts-2025-1", quote: "The fictional Alder customer agreement renews automatically for twelve months unless notice is given ninety days before expiry." };
export const demoEvidence = { ...demoItem, verified: true as const, document: "synthetic_contracts_2025.txt",
  page_label: null, section_title: "Synthetic contracts, 2025" };
export type Scenario = "supported" | "unsupported" | "unavailable";
export class MockBroker implements Broker {
  constructor(private readonly scenario: () => Scenario) {}
  async session(): Promise<Session> { return { signed_url: "mock-session-never-sent", expires_at: new Date(Date.now() + 900000).toISOString() }; }
  async verify(items: Evidence[], signal: AbortSignal): Promise<EvidenceResult[]> {
    await delay(500, signal);
    if (this.scenario() === "unavailable") throw new UiError("mcp_unavailable");
    return items.map(item => item.chunk_id === demoItem.chunk_id && item.quote === demoItem.quote ? { ...demoEvidence } : { chunk_id: item.chunk_id, verified: false });
  }
}
export class MockDriver implements Driver {
  private abort = new AbortController();
  private events: ConversationEvents | undefined;
  private nextId = 1;
  constructor(private readonly scenario: () => Scenario) {}
  start(_session: Session, _textOnly: boolean, events: ConversationEvents): void {
    this.abort = new AbortController(); this.events = events;
    void this.script(events).catch(() => undefined);
  }
  private async script(events: ConversationEvents): Promise<void> {
    await delay(500, this.abort.signal); events.connected();
    await delay(450, this.abort.signal);
    events.message("user", "Which contracts have automatic renewal risk?", this.nextId++);
    await this.answer(events);
  }
  private async answer(events: ConversationEvents): Promise<void> {
    await delay(500, this.abort.signal); events.mode("speaking");
    const unsupported = this.scenario() === "unsupported";
    events.message("agent", unsupported ? "The demonstration sources do not establish a revenue figure. I cannot verify that claim." :
      "The synthetic Alder contract renews for twelve months unless notice is given ninety days before expiry. The source does not quantify the financial exposure.", this.nextId++);
    await events.evidence({ items: unsupported ? [{ ...demoItem, quote: "Alder generates 900 billion in revenue." }] :
      [demoItem, { ...demoItem, quote: "Alder generates 900 billion in revenue." }] });
    await delay(900, this.abort.signal); events.mode("listening");
  }
  async end(): Promise<void> { this.abort.abort(); this.events = undefined; await delay(100); }
  send(text: string): void {
    if (!this.events) return;
    this.abort.abort(); this.abort = new AbortController();
    this.events.interrupted(); this.events.message("user", text, this.nextId++);
    // Never imply arbitrary questions were retrieved/answered by this script.
    this.events.message("agent", "This is a scripted mock conversation. It demonstrates the synthetic contract example only; exact year filtering is unavailable.", this.nextId++);
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); done(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
