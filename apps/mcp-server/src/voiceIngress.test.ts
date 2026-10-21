import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { externalVoiceIngress, readVoiceBody, VoiceIngress } from "./voiceIngress.js";
import { loadGatewayConfig } from "./config.js";

const now = Date.parse("2026-10-20T12:00:00Z");
const env = { VOICE_FEATURE_ENABLED: "true", VOICE_MCP_EXTERNAL_ORIGIN: "https://voice-demo.example.test",
  VOICE_MCP_EXTERNAL_EXPIRES_AT: "2026-10-20T12:20:00Z" };
const configured = () => new VoiceIngress(externalVoiceIngress(env, now), () => now);
function head(headers: IncomingMessage["headers"] = {}) {
  const requestHeaders: IncomingMessage["headers"] = { host: "voice-demo.example.test", "x-forwarded-proto": "https", ...headers };
  return { headers: requestHeaders,
    rawHeaders: [], method: "POST", url: "/mcp", socket: { remoteAddress: "127.0.0.1", localPort: 8787 } };
}

describe("explicit temporary external MCP configuration", () => {
  it("defaults to disabled and never changes ordinary gateway defaults", () => {
    expect(externalVoiceIngress({})).toBeUndefined();
    expect(loadGatewayConfig({}).voiceIngress).toBeUndefined();
    expect(() => new VoiceIngress().classify(head())).toThrow();
  });
  it("requires complete opt-in settings before ordinary gateway startup", () => {
    expect(() => loadGatewayConfig({ ...env, VOICE_FEATURE_ENABLED: "false" })).toThrow();
    expect(() => externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_EXPIRES_AT: "" }, now)).toThrow();
    expect(() => externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_ORIGIN: "" }, now)).toThrow();
  });
  it.each(["http://voice.example.test", "https://*.example.test", "https://user:SECRET@example.test",
    "https://127.0.0.1", "https://localhost", "https://demo.local", "https://foo.localhost",
    "https://example.test/mcp", "https://example.test/", "https://example.test?secret=x", "https://example.test#x",
    "https://example.test:443", "https://example.test:8443", "https://example.test,evil.test"])("rejects unsafe origin %s", origin => {
    expect(() => externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_ORIGIN: origin }, now)).toThrow();
  });
  it.each(["yesterday", "2026-10-20T11:59:00Z", "2026-10-20T12:31:00Z", "2026-10-20T12:00:00Z", "2026-10-20T12:10:00+00:00"])("rejects unsafe expiry %s", expiry => {
    expect(() => externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_EXPIRES_AT: expiry }, now)).toThrow();
  });
  it("requires exact bounded explicit request Origins", () => {
    for (const origin of ["*", "null", "http://localhost:5173", "https://example.test,https://example.test"])
      expect(() => externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_ALLOWED_ORIGINS: origin }, now)).toThrow();
    const ingress = new VoiceIngress(externalVoiceIngress({ ...env, VOICE_MCP_EXTERNAL_ALLOWED_ORIGINS: "https://elevenlabs.io" }, now), () => now);
    expect(ingress.classify(head({ origin: "https://elevenlabs.io" }))).toBe("external");
    expect(() => ingress.classify(head({ origin: "https://other.test" }))).toThrow();
  });
});

describe("request boundary", () => {
  it("accepts a direct local request while requiring HTTPS metadata on the external route", () => {
    const ingress = configured();
    expect(ingress.classify(head())).toBe("external");
    const local = head({ host: "127.0.0.1:8787" }); delete local.headers["x-forwarded-proto"];
    expect(ingress.classify(local)).toBe("local");
    expect(new VoiceIngress().classify(local)).toBe("local");
    local.headers.host = "localhost:8787"; expect(ingress.classify(local)).toBe("local");
  });
  it.each([
    { host: "evil.test" }, { host: "voice-demo.example.test:443" }, { host: "localhost:8787" },
    { host: "127.0.0.1:9999" }, { "x-forwarded-proto": "http" }, { "x-forwarded-proto": "https,http" },
    { forwarded: "proto=https" }, { "x-forwarded-host": "evil.test" }, { "x-forwarded-port": "443" },
    { origin: "null" }, { origin: "https://elevenlabs.io" }, { "x-forwarded-for": "garbage" },
  ])("rejects spoofed or ambiguous headers %j", headers => { expect(() => configured().classify(head(headers))).toThrow(); });
  it("rejects missing HTTPS metadata and duplicate security headers", () => {
    const missing = head(); delete missing.headers["x-forwarded-proto"];
    expect(() => configured().classify(missing)).toThrow();
    for (const key of ["Host", "Origin", "Authorization", "X-Forwarded-Proto", "X-Forwarded-Host", "X-Forwarded-For"]) {
      expect(() => configured().classify({ ...head(), rawHeaders: [key, "one", key.toLowerCase(), "two"] })).toThrow();
    }
  });
  it.each(["192.168.0.4", "::1", undefined])("rejects untrusted peers %s", remoteAddress => {
    expect(() => configured().classify({ ...head(), socket: { remoteAddress, localPort: 8787 } })).toThrow();
  });
  it.each(["/health", "/api/voice/session", "/", "/mcp?token=SECRET", "/mcp/", "https://voice-demo.example.test/mcp", "/%6dcp"])("rejects external route %s", url => {
    expect(() => configured().classify({ ...head(), url })).toThrow();
  });
  it.each(["OPTIONS", "PUT", "HEAD", "CONNECT"])("rejects external method %s", method => {
    expect(() => configured().classify({ ...head(), method })).toThrow();
  });
  it("does not derive authority from a valid-looking forwarded IP or TLS claim", () => {
    expect(configured().classify(head({ "x-forwarded-for": "203.0.113.4, 127.0.0.1", "x-forwarded-host": "voice-demo.example.test" }))).toBe("external");
    expect(() => new VoiceIngress().classify(head({ "x-forwarded-for": "127.0.0.1" }))).toThrow();
  });
  it("fails closed at expiry while retaining direct local access", () => {
    const external = externalVoiceIngress(env, now)!;
    const ingress = new VoiceIngress(external, () => external.expiresAt);
    expect(() => ingress.classify(head())).toThrow();
    const local = head({ host: "127.0.0.1:8787" }); delete local.headers["x-forwarded-proto"];
    expect(ingress.classify(local)).toBe("local");
  });
  it("bounds concurrent requests and releases each reservation only once", () => {
    const ingress = configured(); const release = Array.from({ length: 4 }, () => ingress.reserve());
    expect(() => ingress.reserve()).toThrowError(expect.objectContaining({ status: 429 }));
    release.forEach(done => { done(); done(); });
    const next = Array.from({ length: 4 }, () => ingress.reserve());
    expect(() => ingress.reserve()).toThrow(); next.forEach(done => done());
  });
  it("uses a process-wide minute budget rather than caller-controlled IP headers", () => {
    let time = now; const ingress = new VoiceIngress(undefined, () => time);
    for (let i = 0; i < 120; i++) ingress.reserve()();
    expect(() => ingress.reserve()).toThrow(); time += 60_000;
    expect(() => ingress.reserve()()).not.toThrow();
  });
});

function body(chunks: (Buffer | string)[], headers: IncomingMessage["headers"] = {}) {
  return Object.assign(Readable.from(chunks.map(chunk => Buffer.from(chunk))), { headers: { "content-type": "application/json", ...headers } }) as IncomingMessage;
}
describe("bounded voice request bodies", () => {
  it("parses streamed JSON for the SDK adapter", async () => {
    await expect(readVoiceBody(body(['{"jsonrpc":', '"2.0"}']))).resolves.toEqual({ jsonrpc: "2.0" });
  });
  it.each([{ "content-type": "text/plain" }, { "content-encoding": "gzip" }, { "content-length": "65537" }])("rejects unsafe declared bodies %j", async headers => {
    await expect(readVoiceBody(body(["{}"], headers))).rejects.toThrow();
  });
  it("bounds chunked bodies and rejects malformed UTF-8/JSON without echoing input", async () => {
    for (const chunks of [["a".repeat(65536), "x"], [Buffer.from([0xff])], ["PRIVATE_TOKEN not json"]]) {
      await expect(readVoiceBody(body(chunks))).rejects.toThrow("Voice transport request denied.");
    }
  });
});
