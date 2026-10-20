import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationControlsValue, HookOptions } from "@elevenlabs/react";
import { SdkDriver } from "./sdkDriver.js";
import type { ConversationEvents } from "./conversation.js";
import { deferred, session } from "./testHelpers.js";
function setup() {
  const controls = { startSession: vi.fn<ConversationControlsValue["startSession"]>(), endSession: vi.fn(), sendUserMessage: vi.fn(), sendMCPToolApprovalResult: vi.fn() };
  const events: ConversationEvents = { connected: vi.fn(), disconnected: vi.fn(), failed: vi.fn(), mode: vi.fn(), message: vi.fn(), interrupted: vi.fn(), evidence: vi.fn().mockResolvedValue('{"ok":true}') };
  const driver = new SdkDriver(controls); driver.start(session, false, events);
  return { driver, controls, events, options: controls.startSession.mock.calls[0]![0] as HookOptions };
}
afterEach(() => vi.useRealTimers());
describe("pinned React SDK adapter", () => {
  it("uses signed WebSocket sessions, with no agent override, secret or raw-audio callbacks", () => {
    const { options } = setup();
    expect(options).toMatchObject({ signedUrl: session.signed_url, connectionType: "websocket", textOnly: false });
    for (const key of ["agentId", "authorization", "dynamicVariables", "onAudio", "onDebug", "onIncomingEvent", "onOutgoingEvent"]) expect(options).not.toHaveProperty(key);
    expect(Object.keys(options.clientTools!)).toEqual(["displayEvidence"]);
  });
  it("follows actual callbacks rather than awaiting the void start method", () => {
    const { options, events } = setup(); expect(events.connected).not.toHaveBeenCalled();
    options.onConnect?.({ conversationId: "private-conversation" }); options.onModeChange?.({ mode: "speaking" });
    options.onMessage?.({ role: "user", source: "user", message: "test", event_id: 4 });
    expect(events.connected).toHaveBeenCalledOnce(); expect(events.mode).toHaveBeenCalledWith("speaking");
    expect(events.message).toHaveBeenCalledWith("user", "test", 4);
    options.onError?.("SECRET token and URL", { secret: true }); expect(events.failed).toHaveBeenCalledExactlyOnceWith();
  });
  it("returns the awaited evidence result to the provider", async () => {
    const { options, events } = setup(); const pending = deferred<string>(); vi.mocked(events.evidence).mockReturnValue(pending.promise);
    const result = options.clientTools!.displayEvidence!({ items: [] }); pending.resolve('{"ok":false}');
    expect(await result).toBe('{"ok":false}');
  });
  it("waits for actual disconnected callback before treating end as complete", async () => {
    const { driver, controls, options } = setup(); const ended = vi.fn(); const pending = driver.end().then(ended);
    await Promise.resolve(); expect(controls.endSession).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled();
    options.onDisconnect?.({ reason: "user" }); await pending; expect(ended).toHaveBeenCalledOnce();
  });
  it("fails closed if cleanup is never confirmed", async () => {
    vi.useFakeTimers(); const { driver } = setup(); const end = driver.end(); const check = expect(end).rejects.toMatchObject({ code: "cleanup_failed" });
    await vi.advanceTimersByTimeAsync(5001); await check;
  });
  it("supports text-only sessions and sends via the SDK", async () => {
    const { driver, options, controls, events } = setup(); options.onDisconnect?.({ reason: "user" });
    driver.start(session, true, events); expect(controls.startSession.mock.calls[1]?.[0]?.textOnly).toBe(true);
    driver.send("synthetic question"); expect(controls.sendUserMessage).toHaveBeenCalledWith("synthetic question");
  });
  it("denies all additional MCP approval requests", () => {
    const { options, controls } = setup();
    options.onMCPToolCall?.({ state: "awaiting_approval", tool_call_id: "tool-1" } as Parameters<NonNullable<HookOptions["onMCPToolCall"]>>[0]);
    expect(controls.sendMCPToolApprovalResult).toHaveBeenCalledExactlyOnceWith("tool-1", false);
  });
});
