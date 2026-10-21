import type { ConversationControlsValue, HookOptions } from "@elevenlabs/react";
import type { Session } from "./api.js";
import type { ConversationEvents, Driver } from "./conversation.js";
import { UiError } from "./errors.js";

export class SdkDriver implements Driver {
  private running = false;
  private endWaiter: (() => void) | undefined;
  constructor(private readonly controls: Pick<ConversationControlsValue, "startSession" | "endSession" | "sendUserMessage" | "sendMCPToolApprovalResult">) {}
  start(session: Session, textOnly: boolean, events: ConversationEvents): void {
    if (this.running) throw new UiError("connection_lost");
    this.running = true;
    const closed = () => { this.running = false; this.endWaiter?.(); this.endWaiter = undefined; };
    const options: HookOptions = {
      signedUrl: session.signed_url, connectionType: "websocket", textOnly,
      useWakeLock: false,
      onConnect: () => events.connected(),
      onDisconnect: details => { closed(); events.disconnected(details.reason === "error"); },
      onError: () => events.failed(),
      onStatusChange: ({ status }) => { if (status === "disconnected") closed(); },
      onModeChange: ({ mode }) => events.mode(mode),
      onMessage: ({ role, message, event_id }) => events.message(role, message, event_id),
      onInterruption: () => events.interrupted(),
      onAgentResponseCorrection: () => events.interrupted(),
      onUnhandledClientToolCall: () => events.failed(),
      // This UI never grants additional tool authority. Read tools should not
      // require interactive approval; unexpected approval requests are denied.
      onMCPToolCall: call => { if (call.state === "awaiting_approval") this.controls.sendMCPToolApprovalResult(call.tool_call_id, false); },
      clientTools: { displayEvidence: payload => events.evidence(payload) },
    };
    try { this.controls.startSession(options); } catch { closed(); throw new UiError("connection_lost"); }
  }
  async end(): Promise<void> {
    if (!this.running) return;
    // The React methods return void in 1.19.0. Wait for actual cleanup callbacks.
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => { this.endWaiter = undefined; reject(new UiError("cleanup_failed")); }, 5000);
      this.endWaiter = () => { clearTimeout(timeout); done(); };
      try { this.controls.endSession(); } catch { clearTimeout(timeout); reject(new UiError("cleanup_failed")); }
    });
  }
  send(text: string): void { this.controls.sendUserMessage(text); }
}
