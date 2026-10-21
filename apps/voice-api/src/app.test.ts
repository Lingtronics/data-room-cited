import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocal, createVoiceApi, type AuditEvent, type Dependencies } from "./app.js";
import { VoiceError } from "./errors.js";
import { apiKey, item, signedUrl, testConfig } from "./testSupport.js";
import type { EnabledConfig } from "./config.js";

describe("local voice HTTP API", () => {
  let config: EnabledConfig;
  let server: Server;
  let base: string;
  let deps: Dependencies;
  let events: AuditEvent[];
  beforeEach(async () => {
    config = await testConfig();
    events = [];
    deps = { sessions: { issue: vi.fn().mockResolvedValue({ signed_url: signedUrl, expires_at: "2026-10-20T15:15:00.000Z" }) },
      evidence: { check: vi.fn().mockResolvedValue(undefined), verify: vi.fn().mockResolvedValue([{ ...item,
        verified: true, document: "synthetic_contracts_2025.txt", page_label: null, section_title: "Synthetic contracts, 2025" }]) },
      audit: event => { events.push(event); } };
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done()); server.closeAllConnections();
    });
  });
  async function listen() {
    server = createVoiceApi(config, deps).server;
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test port unavailable");
    base = `http://127.0.0.1:${address.port}`;
  }
  async function post(path = "/api/voice/session", body: unknown = {}, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { method: "POST", headers: { origin: "http://localhost:5173",
      "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  it("issues a no-store URL only after the safe MCP check and logs metadata only", async () => {
    await listen();
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect((await result.json()).signed_url).toBe(signedUrl);
    expect(deps.evidence.check).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.evidence.check).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.sessions.issue).mock.invocationCallOrder[0]!);
    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(JSON.stringify(events)).not.toContain(signedUrl);
    expect(JSON.stringify(events)).not.toContain(config.serviceToken);
    expect(events[0]).toMatchObject({ route: "session", status: 200, correlation_id: expect.any(String), duration_ms: expect.any(Number) });
  });
  it("returns resolved evidence and only counts in logs", async () => {
    await listen();
    const result = await post("/api/voice/evidence/verify", { items: [item] });
    expect(result.status).toBe(200);
    expect((await result.json()).items[0]).toMatchObject({ ...item, verified: true });
    expect(events[0]).toMatchObject({ verified_count: 1, rejected_count: 0 });
    expect(JSON.stringify(events)).not.toContain(item.quote);
    expect(JSON.stringify(events)).not.toContain(item.chunk_id);
  });
  it("permits only the exact allowed preflight", async () => {
    await listen();
    const headers = { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type" };
    expect((await fetch(`${base}/api/voice/session`, { method: "OPTIONS", headers })).status).toBe(204);
    expect((await fetch(`${base}/api/voice/session`, { method: "OPTIONS", headers: { ...headers, "access-control-request-headers": "authorization" } })).status).toBe(403);
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it.each(["", "null", "https://evil.test", "http://localhost:5173.evil.test", "http://localhost:5174"])("denies spoofed/missing Origin %s", async origin => {
    await listen();
    const result = await post(undefined, {}, { origin });
    expect(result.status).toBe(403);
    expect(result.headers.has("access-control-allow-origin")).toBe(false);
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it.each([{ host: "evil.test" }, { forwarded: "for=127.0.0.1" }, { "x-forwarded-host": "localhost" }])("denies forged Host/proxy headers", async extra => {
    await listen();
    const status = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(`${base}/api/voice/session`, { method: "POST", headers: {
        origin: "http://localhost:5173", "content-type": "application/json", ...extra,
      } }, res => { res.resume(); done(res.statusCode); });
      request.on("error", reject); request.end("{}");
    });
    expect(status).toBe(403);
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it.each([undefined, "192.168.1.1", "::1"])("rejects non-bound remote addresses %s", remoteAddress => {
    expect(() => assertLocal({ headers: { host: "localhost:8790" },
      socket: { remoteAddress, localPort: 8790 } } as IncomingMessage)).toThrow(VoiceError);
  });
  it.each([{ agent_id: "attacker" }, { api_key: "SECRET" }, [], null, "text"])("rejects session parameters %j", async body => {
    await listen();
    const result = await post(undefined, body);
    expect(result.status).toBe(400);
    expect(JSON.stringify(await result.json())).not.toContain("SECRET");
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it.each([
    {}, { items: [] }, { items: Array(6).fill(item) }, { items: [item], extra: true },
    { items: [{ ...item, document: "forged.txt" }] }, { items: [{ ...item, verified: true }] },
    { items: [{ ...item, quote: "" }] }, { items: [{ ...item, quote: "x".repeat(5001) }] },
    { items: [{ ...item, chunk_id: "x".repeat(201) }] }, { items: [{ ...item, quote: "x\u0000y" }] },
    { items: [{ ...item, quote: "x\u202ey" }] },
  ])("rejects malformed evidence before calling MCP", async body => {
    await listen();
    expect((await post("/api/voice/evidence/verify", body)).status).toBe(400);
    expect(deps.evidence.verify).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON, oversized bodies, content types, methods and URLs", async () => {
    await listen();
    const headers = { origin: "http://localhost:5173", "content-type": "application/json" };
    expect((await fetch(`${base}/api/voice/session`, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await post(undefined, { text: "x".repeat(66000) })).status).toBe(413);
    expect((await post(undefined, {}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await fetch(`${base}/api/voice/session`, { headers })).status).toBe(405);
    expect((await post("/api/voice/session?secret=SECRET")).status).toBe(404);
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it("bounds chunked bodies without relying on Content-Length", async () => {
    await listen();
    const status = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(`${base}/api/voice/session`, { method: "POST", headers: {
        origin: "http://localhost:5173", "content-type": "application/json", "transfer-encoding": "chunked",
      } }, res => { res.resume(); done(res.statusCode); });
      request.on("error", reject); request.write("x".repeat(66000)); request.end();
    });
    expect(status).toBe(413);
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it("reports missing provider configuration without calling upstream", async () => {
    config.apiKey = "";
    await listen();
    const result = await post();
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("config_missing");
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it("keeps evidence available without provider credentials", async () => {
    config.apiKey = ""; config.agentId = "";
    await listen();
    expect((await post("/api/voice/evidence/verify", { items: [item] })).status).toBe(200);
  });
  it("blocks sessions when the MCP policy fails", async () => {
    vi.mocked(deps.evidence.check).mockRejectedValue(new VoiceError("mcp_unsafe"));
    await listen();
    expect((await post()).status).toBe(503);
    expect(deps.sessions.issue).not.toHaveBeenCalled();
  });
  it("maps unknown upstream exceptions without leaking diagnostics", async () => {
    vi.mocked(deps.sessions.issue).mockRejectedValue(new Error(`${apiKey} ${signedUrl} ${config.serviceToken}`));
    await listen();
    const result = await post();
    const diagnostic = JSON.stringify(await result.json()) + JSON.stringify(events);
    expect(result.status).toBe(500);
    for (const value of [apiKey, signedUrl, config.serviceToken]) expect(diagnostic).not.toContain(value);
    expect(diagnostic).toContain("internal_error");
  });
  it("enforces the session cap across concurrent requests, including failed attempts", async () => {
    config.maxSessions = 1;
    vi.mocked(deps.sessions.issue).mockRejectedValue(new VoiceError("session_timeout"));
    await listen();
    const responses = await Promise.all([post(), post(), post()]);
    expect(responses.map(res => res.status).sort()).toEqual([429, 429, 504]);
    expect(deps.sessions.issue).toHaveBeenCalledOnce();
  });
  it("throttles globally rather than trusting a spoofable identity", async () => {
    config.requestsPerMinute = 1;
    await listen();
    expect((await post()).status).toBe(200);
    const result = await post("/api/voice/evidence/verify", { items: [item] });
    expect(result.status).toBe(429);
    expect((await result.json()).error.code).toBe("rate_limited");
    expect(deps.evidence.verify).not.toHaveBeenCalled();
  });
  it("does not listen when disabled or when startup MCP validation fails", async () => {
    const disabled = createVoiceApi({ enabled: false }, deps);
    await disabled.start();
    expect(disabled.server.listening).toBe(false);
    expect(deps.evidence.check).not.toHaveBeenCalled();
    vi.mocked(deps.evidence.check).mockRejectedValue(new VoiceError("mcp_unavailable"));
    const app = createVoiceApi(config, deps);
    await expect(app.start()).rejects.toMatchObject({ code: "mcp_unavailable" });
    expect(app.server.listening).toBe(false);
  });
});
