import { describe, expect, it, vi } from "vitest";
import { ElevenLabsSessions } from "./elevenLabs.js";
import { apiKey, agentId, response, signedUrl, testConfig } from "./testSupport.js";

describe("fixed-agent signed URL adapter", () => {
  it("uses the documented endpoint/server key, single-use option and conservative 15-minute expiry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ signed_url: signedUrl }));
    const config = await testConfig();
    const service = new ElevenLabsSessions(config, fetcher, () => Date.parse("2026-10-20T10:00:00Z"));
    expect(await service.issue()).toEqual({ signed_url: signedUrl, expires_at: "2026-10-20T10:15:00.000Z" });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}&include_conversation_id=true`);
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { "xi-api-key": apiKey } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    fetcher.mockResolvedValue(response({ signed_url: signedUrl.replace("sentinel", "fresh") }));
    expect((await service.issue()).signed_url).toContain("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["apiKey", "agentId"] as const)("fails missing %s before network access", async key => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ElevenLabsSessions(await testConfig({ [key]: "" }), fetcher).issue()).rejects.toMatchObject({ code: "config_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500, 503])("maps upstream HTTP %i without body or secret leakage and without retries", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: apiKey, signed_url: signedUrl }, status));
    const promise = new ElevenLabsSessions(await testConfig(), fetcher).issue();
    await expect(promise).rejects.toMatchObject({ code: "session_upstream_failed" });
    await expect(promise).rejects.not.toThrow(apiKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { signed_url: "https://evil.test" }, { signed_url: signedUrl.replace(agentId, "agent_other") },
    { signed_url: signedUrl.replace("api.elevenlabs.io", "api.elevenlabs.io.evil.test") },
    { signed_url: signedUrl.replace("wss:", "ws:") }, { signed_url: signedUrl + "&api_key=SECRET" },
    { signed_url: signedUrl + `&agent_id=${agentId}` }, { signed_url: signedUrl + "#SECRET" },
    { signed_url: signedUrl, api_key: apiKey }, { signed_url: signedUrl.replace("private-signature-sentinel", apiKey) },
    { signed_url: signedUrl.replace("private-signature-sentinel", "%6d" + apiKey.slice(1)) },
    { signed_url: signedUrl + "\n" },
  ])("rejects malformed or unsafe provider responses", async data => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(data));
    await expect(new ElevenLabsSessions(await testConfig(), fetcher).issue()).rejects.toMatchObject({ code: "session_invalid_response" });
  });

  it("sanitizes malformed JSON and oversized upstream bodies", async () => {
    for (const body of [`{"secret":"${apiKey}`, "SECRET".repeat(4000)]) {
      const service = new ElevenLabsSessions(await testConfig(), vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
      try { await service.issue(); expect.fail("Expected failure"); }
      catch (error) { expect(String(error)).not.toContain(apiKey); expect(String(error)).not.toContain("SECRET"); }
    }
  });

  it("aborts a timed-out request, emits a stable error and never retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_done, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error(`SECRET ${signedUrl}`)), { once: true });
    }));
    await expect(new ElevenLabsSessions(await testConfig({ upstreamTimeoutMs: 100 }), fetcher).issue()).rejects.toMatchObject({ code: "session_timeout" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
