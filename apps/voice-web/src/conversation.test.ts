import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationController } from "./conversation.js";
import { UiError } from "./errors.js";
import { demoEvidence, demoItem } from "./mock.js";
import { brokerMock, deferred, FakeDriver, flush } from "./testHelpers.js";

describe("conversation lifecycle and evidence authority", () => {
  let driver: FakeDriver; let broker: ReturnType<typeof brokerMock>; let controller: ConversationController;
  beforeEach(() => { vi.useFakeTimers(); driver = new FakeDriver(); broker = brokerMock(); controller = new ConversationController(broker, driver, { mock: true, maxSessionMs: 60_000 }); });
  afterEach(() => { controller.dispose(); vi.clearAllTimers(); vi.useRealTimers(); });
  async function connect() { await controller.start("voice"); driver.events!.connected(); }
  it("starts only on request, tracks callbacks, and clears the session on end", async () => {
    const phases: string[] = []; controller.subscribe(() => phases.push(controller.getSnapshot().phase));
    expect(broker.session).not.toHaveBeenCalled();
    await connect(); driver.events!.mode("speaking"); driver.events!.message("agent", "Synthetic answer", 1);
    await driver.events!.evidence({ items: [demoItem] });
    expect(controller.getSnapshot().evidence).toEqual([demoEvidence]);
    await controller.end();
    expect(phases).toEqual(expect.arrayContaining(["requesting_permission", "connecting", "listening", "agent_speaking", "disconnecting", "idle"]));
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", evidence: [], transcript: [] });
    expect(driver.end).toHaveBeenCalledOnce();
  });
  it("prevents duplicate starts", async () => {
    await Promise.all([controller.start("voice"), controller.start("voice")]);
    expect(broker.session).toHaveBeenCalledOnce(); expect(driver.start).toHaveBeenCalledOnce();
  });
  it("stops permission preflight tracks before the SDK acquires audio", async () => {
    const stop = vi.fn(); const microphone = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    controller = new ConversationController(broker, driver, { mock: false, maxSessionMs: 60_000, microphone });
    expect(microphone).not.toHaveBeenCalled(); await controller.start("voice");
    expect(stop).toHaveBeenCalledOnce(); expect(stop.mock.invocationCallOrder[0]).toBeLessThan(broker.session.mock.invocationCallOrder[0]!);
  });
  it("denies microphone access before issuing a session and supports text retry", async () => {
    const microphone = vi.fn().mockRejectedValue(new DOMException("SECRET", "NotAllowedError"));
    controller = new ConversationController(broker, driver, { mock: false, maxSessionMs: 60_000, microphone });
    await controller.start("voice");
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "microphone_denied" });
    expect(broker.session).not.toHaveBeenCalled();
    await controller.start("text"); expect(driver.start.mock.calls[0]?.[1]).toBe(true);
    expect(microphone).toHaveBeenCalledOnce();
  });
  it.each(["cancel", "unmount"])("stops late permission streams after %s", async action => {
    const pending = deferred<MediaStream>(); const stop = vi.fn();
    controller = new ConversationController(broker, driver, { mock: false, maxSessionMs: 60_000, microphone: () => pending.promise });
    const start = controller.start("voice");
    if (action === "cancel") await controller.end(); else controller.dispose();
    pending.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream); await start;
    expect(stop).toHaveBeenCalledOnce(); expect(broker.session).not.toHaveBeenCalled(); expect(driver.start).not.toHaveBeenCalled();
  });
  it("times out unanswered permission without issuing a URL", async () => {
    const pending = deferred<MediaStream>();
    controller = new ConversationController(broker, driver, { mock: false, maxSessionMs: 60_000, microphone: () => pending.promise, permissionTimeoutMs: 100 });
    void controller.start("voice"); await vi.advanceTimersByTimeAsync(101);
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "permission_timeout" }); expect(broker.session).not.toHaveBeenCalled();
    const stop = vi.fn(); pending.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream); await flush(); expect(stop).toHaveBeenCalledOnce();
  });
  it("aborts pending URL issuance and ignores a late success", async () => {
    const pending = deferred<Awaited<ReturnType<typeof broker.session>>>(); broker.session.mockReturnValue(pending.promise);
    const start = controller.start("text"); const signal = broker.session.mock.calls[0]![0];
    await controller.end(); expect(signal.aborted).toBe(true);
    pending.resolve({ signed_url: "PRIVATE", expires_at: "2099" }); await start;
    expect(driver.start).not.toHaveBeenCalled();
  });
  it("uses a fresh session on retry, never surfaces raw errors", async () => {
    broker.session.mockRejectedValueOnce(new Error("PRIVATE_SIGNATURE secret quote"));
    await controller.start("text"); expect(JSON.stringify(controller.getSnapshot())).not.toContain("PRIVATE");
    expect(controller.getSnapshot().error).toBe("session_failed");
    await controller.start("text"); expect(broker.session).toHaveBeenCalledTimes(2);
  });
  it("bounds connection and session durations", async () => {
    controller = new ConversationController(broker, driver, { mock: true, maxSessionMs: 60_000, connectionTimeoutMs: 100 });
    await controller.start("text"); await vi.advanceTimersByTimeAsync(101);
    expect(controller.getSnapshot().error).toBe("connection_timeout");
    await connect(); await vi.advanceTimersByTimeAsync(60_001);
    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", evidence: [], notice: "The local session time limit was reached." });
  });
  it("clears evidence on interruption and on a new user message", async () => {
    await connect(); await driver.events!.evidence({ items: [demoItem] }); driver.events!.interrupted();
    expect(controller.getSnapshot().evidence).toEqual([]);
    await driver.events!.evidence({ items: [demoItem] }); driver.events!.message("user", "Only 2025", 1);
    expect(controller.getSnapshot().evidence).toEqual([]);
  });
  it("does not display incorrect quotes or server-provided false items", async () => {
    await connect(); broker.verify.mockResolvedValue([{ chunk_id: demoItem.chunk_id, verified: false }]);
    expect(await driver.events!.evidence({ items: [demoItem] })).toContain('"verified_count":0');
    expect(controller.getSnapshot()).toMatchObject({ evidence: [], evidenceState: "none", rejected: 1 });
    broker.verify.mockResolvedValue([{ ...demoEvidence, quote: "invented" }]);
    expect(await driver.events!.evidence({ items: [demoItem] })).toContain("verification_failed");
    expect(controller.getSnapshot().evidence).toEqual([]);
  });
  it.each([{}, { items: [] }, { items: [demoItem], extra: true }, { items: [{ ...demoItem, verified: true }] },
    { items: Array(6).fill(demoItem) }, { items: [{ ...demoItem, quote: "x".repeat(5001) }] },
    { items: [{ ...demoItem, quote: "hidden\u202etext" }] }])("validates client-tool payloads before requests", async payload => {
    await connect(); expect(await driver.events!.evidence(payload)).toContain("invalid_evidence"); expect(broker.verify).not.toHaveBeenCalled();
  });
  it("awaits evidence verification before returning counts to the agent", async () => {
    await connect(); const pending = deferred<typeof demoEvidence[]>(); broker.verify.mockReturnValue(pending.promise);
    const response = driver.events!.evidence({ items: [demoItem] });
    expect(controller.getSnapshot().evidenceState).toBe("checking"); expect(controller.getSnapshot().evidence).toEqual([]);
    pending.resolve([demoEvidence]); expect(await response).toBe('{"ok":true,"verified_count":1,"rejected_count":0}');
  });
  it("does not revive evidence from a stopped or replaced session", async () => {
    await connect(); const old = driver.events!; const pending = deferred<typeof demoEvidence[]>(); broker.verify.mockReturnValue(pending.promise);
    const check = old.evidence({ items: [demoItem] }); await controller.end(); await connect();
    old.message("agent", "Stale response", 90); old.disconnected(true); old.mode("speaking");
    pending.resolve([demoEvidence]); expect(await check).toContain("stale_evidence");
    expect(controller.getSnapshot()).toMatchObject({ phase: "listening", transcript: [], evidence: [] });
    expect(await old.evidence({ items: [demoItem] })).toContain("session_ended");
  });
  it("cancels earlier overlapping evidence requests and keeps the latest result", async () => {
    await connect(); const pending = deferred<typeof demoEvidence[]>(); broker.verify.mockReturnValueOnce(pending.promise);
    const earlier = driver.events!.evidence({ items: [demoItem] }); const signal = broker.verify.mock.calls[0]![1];
    broker.verify.mockResolvedValue([{ chunk_id: demoItem.chunk_id, verified: false }]);
    await driver.events!.evidence({ items: [demoItem] }); expect(signal.aborted).toBe(true);
    pending.resolve([demoEvidence]); expect(await earlier).toContain("stale_evidence"); expect(controller.getSnapshot().evidence).toEqual([]);
  });
  it("invalidates a pending check when the user changes the question", async () => {
    await connect(); const pending = deferred<typeof demoEvidence[]>(); broker.verify.mockReturnValue(pending.promise);
    const check = driver.events!.evidence({ items: [demoItem] }); driver.events!.message("user", "new question", 1);
    pending.resolve([demoEvidence]); expect(await check).toContain("stale_evidence"); expect(controller.getSnapshot().evidence).toEqual([]);
  });
  it("maps MCP failures and allows an explicit new evidence attempt", async () => {
    await connect(); broker.verify.mockRejectedValueOnce(new UiError("mcp_unavailable"));
    await driver.events!.evidence({ items: [demoItem] }); expect(controller.getSnapshot().error).toBe("mcp_unavailable");
    await driver.events!.evidence({ items: [demoItem] }); expect(controller.getSnapshot().error).toBeNull();
  });
  it("clears data on unexpected disconnect and refuses retry if cleanup fails", async () => {
    await connect(); driver.events!.message("agent", "private text", 1); driver.events!.disconnected(true); await flush();
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "connection_lost", transcript: [], evidence: [] });
    await connect(); driver.end.mockRejectedValue(new Error("PRIVATE cleanup")); await controller.end();
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "cleanup_failed", canRetry: false });
    const count = broker.session.mock.calls.length; await controller.start("voice"); expect(broker.session).toHaveBeenCalledTimes(count);
  });
  it("bounds and deduplicates transcript text, and ignores unsupported sends", async () => {
    controller.send("before connection"); await connect(); controller.send("voice mode"); expect(driver.send).not.toHaveBeenCalled();
    for (let id = 0; id < 45; id++) driver.events!.message("agent", "x".repeat(5000), id);
    driver.events!.message("agent", "corrected\u202etext", 44);
    expect(controller.getSnapshot().transcript).toHaveLength(40); expect(controller.getSnapshot().transcript[0]?.text).toHaveLength(4000);
    expect(controller.getSnapshot().transcript.at(-1)?.text).toBe("correctedtext");
    await controller.end(); await controller.start("text"); driver.events!.connected(); controller.send("  valid question  ");
    controller.send("x".repeat(2001)); expect(driver.send).toHaveBeenCalledExactlyOnceWith("valid question");
  });
});
