import { describe, expect, it, vi } from "vitest";
import { LocalBroker, validSession, verifiedResponse } from "./api.js";
import { demoEvidence, demoItem } from "./mock.js";
import { session } from "./testHelpers.js";
const origin = "http://127.0.0.1:8790";
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("local API client", () => {
  it("uses the existing POST contracts, sends no authority, and never persists URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({ items: [demoEvidence] }));
    const broker = new LocalBroker(origin, fetcher);
    expect(await broker.session(signal())).toEqual(session);
    expect(await broker.verify([demoItem], signal())).toEqual([demoEvidence]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${origin}/api/voice/session`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", body: "{}", headers: { "content-type": "application/json" } });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ items: [demoItem] }));
  });
  it.each(["https://evil.test", "http://localhost:8790", "http://127.0.0.1:8790/path", "http://secret@127.0.0.1:8790", "http://127.0.0.1:8790?key=SECRET"])("rejects unsafe API origins %s", value => {
    expect(() => new LocalBroker(value)).toThrow("local development page");
  });
  it.each([
    ["config_missing", "config_missing"], ["mcp_unavailable", "mcp_unavailable"], ["mcp_unsafe", "mcp_unavailable"],
    ["mcp_timeout", "mcp_unavailable"], ["fixture_unavailable", "mcp_unavailable"], ["session_timeout", "session_failed"],
    ["rate_limited", "rate_limited"], ["session_limit_reached", "rate_limited"], ["UNKNOWN_PRIVATE", "session_failed"],
  ])("maps %s to a safe UI category", async (code, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code, message: "SECRET upstream details" } }, 503));
    const result = new LocalBroker(origin, fetcher).session(signal());
    await expect(result).rejects.toMatchObject({ code: expected }); await expect(result).rejects.not.toThrow("SECRET");
  });
  it.each(["{" , "SECRET".repeat(12000)])("bounds and sanitizes invalid response bodies", async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = new LocalBroker(origin, fetcher).verify([demoItem], signal());
    await expect(result).rejects.toMatchObject({ code: "verification_failed" }); await expect(result).rejects.not.toThrow("SECRET");
  });
  it("propagates cancellation and times out without retrying", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_done, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE")), { once: true })));
      const abort = new AbortController(); const broker = new LocalBroker(origin, fetcher);
      const cancelled = broker.session(abort.signal); const cancelCheck = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      abort.abort(); await cancelCheck;
      const timedOut = broker.session(signal()); const timeoutCheck = expect(timedOut).rejects.toMatchObject({ code: "session_failed" });
      await vi.advanceTimersByTimeAsync(20001); await timeoutCheck; expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("validates evidence locally before a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new LocalBroker(origin, fetcher).verify([{ ...demoItem, quote: "" }], signal())).rejects.toMatchObject({ code: "invalid_evidence" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("untrusted session and evidence responses", () => {
  it.each([
    { ...session, expires_at: "2000-01-01T00:00:00.000Z" }, { ...session, expires_at: "2099-01-01T00:00:00.000Z" },
    { ...session, signed_url: session.signed_url.replace("wss:", "ws:") },
    { ...session, signed_url: session.signed_url.replace("api.elevenlabs.io", "evil.test") },
    { ...session, signed_url: session.signed_url + "&api_key=SECRET" }, { ...session, api_key: "SECRET" },
    { ...session, signed_url: session.signed_url + "&agent_id=agent_other" },
  ])("rejects invalid, expired and unsafe sessions", value => { expect(() => validSession(value)).toThrow(); });
  it.each([
    { items: [] }, { items: [{ ...demoEvidence, quote: "invented" }] }, { items: [{ ...demoEvidence, chunk_id: "other" }] },
    { items: [{ ...demoEvidence, verified: "true" }] }, { items: [{ ...demoEvidence, page_label: "99" }] },
    { items: [{ ...demoEvidence, link: "javascript:alert(1)" }] }, { items: [demoEvidence], error: "SECRET" },
  ])("refuses malformed, unmatched or invented metadata envelopes", data => { expect(() => verifiedResponse(data, [demoItem])).toThrow(); });
});
