import { EvidenceInput, type EvidenceResult } from "@data-room-cited/voice-api/contracts";
import { type Broker, type Session, verifiedResponse } from "./api.js";
import { safeCode, UiError, type ErrorCode } from "./errors.js";

export type Phase = "idle" | "requesting_permission" | "connecting" | "listening" | "agent_speaking" | "disconnecting" | "error";
export type Message = { role: "user" | "agent"; text: string; id: number };
export type VerifiedEvidence = Extract<EvidenceResult, { verified: true }>;
export type Snapshot = { phase: Phase; kind: "voice" | "text"; transcript: Message[]; evidence: VerifiedEvidence[];
  evidenceState: "empty" | "checking" | "verified" | "none" | "error"; rejected: number;
  error: ErrorCode | null; notice: string; canRetry: boolean };
export type ConversationEvents = {
  connected(): void; disconnected(failed: boolean): void; failed(): void;
  mode(mode: "speaking" | "listening"): void; message(role: "user" | "agent", text: string, id: number): void;
  interrupted(): void; evidence(payload: unknown): Promise<string>;
};
export interface Driver {
  start(session: Session, textOnly: boolean, events: ConversationEvents): void;
  end(): Promise<void>;
  send(text: string): void;
}
const initial = (): Snapshot => ({ phase: "idle", kind: "voice", transcript: [], evidence: [], evidenceState: "empty",
  rejected: 0, error: null, notice: "", canRetry: true });

export class ConversationController {
  private state = initial();
  private listeners = new Set<() => void>();
  private generation = 0;
  private evidenceGeneration = 0;
  private sessionAbort = new AbortController();
  private evidenceAbort = new AbortController();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private ending: Promise<void> | undefined;
  constructor(private readonly broker: Broker, private readonly driver: Driver, private readonly options: {
    mock: boolean; maxSessionMs: number; microphone?: () => Promise<MediaStream>;
    permissionTimeoutMs?: number; connectionTimeoutMs?: number;
  }) {}
  getSnapshot = (): Snapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(update: Partial<Snapshot>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
  }
  private timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); return timer;
  }
  private clear(timer: ReturnType<typeof setTimeout>): void { clearTimeout(timer); this.timers.delete(timer); }
  private current(id: number): boolean { return !this.disposed && this.generation === id && !this.sessionAbort.signal.aborted; }
  private clearEvidence(): void {
    ++this.evidenceGeneration; this.evidenceAbort.abort(); this.evidenceAbort = new AbortController();
    this.set({ evidence: [], evidenceState: "empty", rejected: 0 });
  }

  async start(kind: "voice" | "text"): Promise<void> {
    if (this.disposed || this.ending || !this.state.canRetry || !["idle", "error"].includes(this.state.phase)) return;
    const id = ++this.generation;
    this.sessionAbort = new AbortController();
    this.clearEvidence();
    this.set({ ...initial(), kind, phase: kind === "voice" ? "requesting_permission" : "connecting" });
    this.timer(() => { void this.end("The local session time limit was reached."); }, this.options.maxSessionMs);
    try {
      if (kind === "voice" && !this.options.mock) {
        if (!this.options.microphone) throw new UiError("microphone_unavailable");
        const deadline = this.timer(() => { if (this.current(id)) void this.fail("permission_timeout"); }, this.options.permissionTimeoutMs ?? 20_000);
        let stream: MediaStream;
        try { stream = await this.options.microphone(); }
        catch (error) {
          if (!this.current(id)) return;
          throw new UiError(error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name) ? "microphone_denied" : "microphone_unavailable");
        } finally { this.clear(deadline); }
        // This is only a permission preflight. The SDK owns its actual audio stream.
        // A permission prompt can resolve after Cancel/unmount; always stop its tracks.
        stream.getTracks().forEach(track => track.stop());
      }
      if (!this.current(id)) return;
      this.set({ phase: "connecting" });
      const session = await this.broker.session(this.sessionAbort.signal);
      if (!this.current(id)) return;
      const connectionDeadline = this.timer(() => { if (this.current(id)) void this.fail("connection_timeout"); }, this.options.connectionTimeoutMs ?? 30_000);
      this.driver.start(session, kind === "text", {
        connected: () => { if (this.current(id)) { this.clear(connectionDeadline); this.set({ phase: "listening" }); } },
        disconnected: failed => { if (this.current(id)) void (failed ? this.fail("connection_lost") : this.end("Conversation ended.")); },
        failed: () => { if (this.current(id)) void this.fail("connection_lost"); },
        mode: mode => { if (this.current(id) && ["listening", "agent_speaking"].includes(this.state.phase)) this.set({ phase: mode === "speaking" ? "agent_speaking" : "listening" }); },
        message: (role, text, eventId) => {
          if (!this.current(id) || !["listening", "agent_speaking"].includes(this.state.phase) ||
              !["user", "agent"].includes(role) || typeof text !== "string" || !Number.isSafeInteger(eventId)) return;
          if (role === "user") this.clearEvidence();
          const safeText = text.slice(0, 4000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
          const transcript = this.state.transcript.filter(message => message.role !== role || message.id !== eventId);
          this.set({ transcript: [...transcript, { role, text: safeText, id: eventId }].slice(-40) });
        },
        interrupted: () => { if (this.current(id)) { this.clearEvidence(); this.set({ phase: "listening" }); } },
        evidence: payload => this.displayEvidence(id, payload),
      });
    } catch (error) { if (this.current(id)) await this.fail(safeCode(error, "session_failed")); }
  }

  private async displayEvidence(session: number, payload: unknown): Promise<string> {
    if (!this.current(session) || !["listening", "agent_speaking"].includes(this.state.phase)) return '{"ok":false,"code":"session_ended"}';
    this.clearEvidence();
    const revision = this.evidenceGeneration;
    const parsed = EvidenceInput.safeParse(payload);
    if (!parsed.success) { this.set({ evidenceState: "error", error: "invalid_evidence" }); return '{"ok":false,"code":"invalid_evidence"}'; }
    this.set({ evidenceState: "checking", error: null });
    try {
      const items = verifiedResponse({ items: await this.broker.verify(parsed.data.items, this.evidenceAbort.signal) }, parsed.data.items);
      if (!this.current(session) || revision !== this.evidenceGeneration) return '{"ok":false,"code":"stale_evidence"}';
      const evidence = items.filter((item): item is VerifiedEvidence => item.verified);
      this.set({ evidence, evidenceState: evidence.length ? "verified" : "none", rejected: items.length - evidence.length });
      return JSON.stringify({ ok: true, verified_count: evidence.length, rejected_count: items.length - evidence.length });
    } catch (error) {
      if (!this.current(session) || revision !== this.evidenceGeneration) return '{"ok":false,"code":"stale_evidence"}';
      const code = safeCode(error, "verification_failed");
      this.set({ evidence: [], evidenceState: "error", error: code });
      return JSON.stringify({ ok: false, code });
    }
  }

  send(text: string): void {
    const value = text.trim();
    if (this.state.kind !== "text" || !["listening", "agent_speaking"].includes(this.state.phase) || !value || value.length > 2000) return;
    this.clearEvidence();
    try { this.driver.send(value); } catch { void this.fail("connection_lost"); }
  }
  private fail(code: ErrorCode): Promise<void> { return this.stop("", code); }
  end = (notice = "Conversation ended. Session text and evidence cleared."): Promise<void> => this.stop(notice);
  private stop(notice: string, error: ErrorCode | null = null): Promise<void> {
    if (this.ending) return this.ending;
    ++this.generation; this.sessionAbort.abort(); this.clearEvidence();
    this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear();
    this.set({ phase: "disconnecting", transcript: [], error: null });
    this.ending = (async () => {
      try { await this.driver.end(); this.set({ phase: error ? "error" : "idle", error, notice }); }
      catch { this.set({ phase: "error", error: "cleanup_failed", canRetry: false, notice: "" }); }
      finally { this.ending = undefined; }
    })();
    return this.ending;
  }
  dispose = (): void => {
    if (this.disposed) return;
    void this.end(); this.disposed = true; this.listeners.clear();
    this.state = initial();
  };
}
