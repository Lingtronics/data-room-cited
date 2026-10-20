import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { authenticateRequest, type AccessContext } from "./auth.js";
import { loadGatewayConfig } from "./config.js";
import { createDataRoomMcpServer } from "./mcpServer.js";
import { RagCoreClient } from "./ragCoreClient.js";
import { VoiceSearchInputSchema, VoiceVerifyInputSchema } from "./schemas.js";

const root = resolve(import.meta.dirname, "../../..");
const temporary = mkdtempSync(resolve(tmpdir(), "drc-voice-policy-"));
cpSync(resolve(root, "fixtures/voice/data"), resolve(temporary, "data"), { recursive: true });
cpSync(resolve(root, "fixtures/voice/index"), resolve(temporary, "index"), { recursive: true });
const secret = randomBytes(32).toString("hex");
const env = {
  VOICE_FEATURE_ENABLED: "true", VOICE_READ_ONLY_DEMO: "true",
  MCP_AUTH_REQUIRED: "true", MCP_ALLOW_DEV_TOKENS: "false",
  MCP_AUTH_ISSUER: "voice-tests", MCP_AUTH_AUDIENCE: "voice-test-gateway",
  MCP_DEV_JWT_SECRET: secret, RAG_CORE_BASE_URL: "http://127.0.0.1:8767",
  VOICE_FIXTURE_DATA_DIR: resolve(temporary, "data"), VOICE_FIXTURE_INDEX_DIR: resolve(temporary, "index"),
};
const config = loadGatewayConfig(env);
const policy = config.voicePolicy!;
const access: AccessContext = {
  token: "opaque-test-token", authMode: "jwt", clientId: "test", userId: "test",
  workspaceId: policy.workspaceId, role: "reader", scopes: ["documents:read", "citations:verify"],
  allowedDocumentIds: [...policy.documents], approvalGrants: [], expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const claims = {
  sub: "test", iss: env.MCP_AUTH_ISSUER, aud: env.MCP_AUTH_AUDIENCE,
  exp: access.expiresAt, workspace_id: policy.workspaceId, role: "reader",
  scope: "documents:read citations:verify", document_ids: [...policy.documents],
};
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe("voice configuration and JWT policy", () => {
  it("leaves ordinary instance defaults intact", () => {
    const ordinary = loadGatewayConfig({});
    expect(ordinary.voicePolicy).toBeUndefined();
    expect(ordinary.authRequired).toBe(false);
    expect(ordinary.allowDevTokens).toBe(true);
    expect(config.host).toBe("127.0.0.1");
  });

  it.each([
    ["VOICE_FEATURE_ENABLED", "typo"], ["VOICE_READ_ONLY_DEMO", "false"],
    ["MCP_AUTH_REQUIRED", "false"], ["MCP_ALLOW_DEV_TOKENS", "true"],
    ["MCP_AUTH_ISSUER", ""], ["MCP_AUTH_AUDIENCE", ""],
    ["MCP_DEV_JWT_SECRET", "local-dev-only-change-me"], ["MCP_JWKS_URL", "http://example.test/keys"],
    ["MCP_GATEWAY_HOST", "0.0.0.0"], ["MCP_DEFAULT_SCOPES", "admin:connectors"],
    ["RAG_CORE_BASE_URL", "https://example.test"], ["RAG_CORE_BASE_URL", "http://127.0.0.1/private"],
    ["RAG_CORE_BASE_URL", "http://user:secret@127.0.0.1"], ["VOICE_FIXTURE_DATA_DIR", "data"],
    ["VOICE_FIXTURE_INDEX_DIR", resolve(root, "index")],
  ])("refuses unsafe startup: %s=%s", (key, value) => {
    expect(() => loadGatewayConfig({ ...env, [key]: value })).toThrow();
  });

  it("accepts a dedicated expiring read-only service identity", async () => {
    const token = await mint(claims);
    expect((await authenticateRequest(`Bearer ${token}`, config)).allowedDocumentIds).toEqual(policy.documents);
  });

  it.each([undefined, "Bearer read", "Bearer admin", "Bearer junk", "Basic abc"])("rejects bad bearer %s", async header => {
    await expect(authenticateRequest(header, config)).rejects.toThrow();
  });

  it.each([
    { aud: "other" }, { iss: "other" }, { exp: 1 }, { exp: undefined }, { sub: undefined },
    { workspace_id: "other" }, { document_ids: [] }, { document_ids: ["private.pdf"] },
    { document_ids: ["synthetic_contracts_2025.txt.backup"] }, { document_ids: "synthetic_contracts_2025.txt" },
    { scope: "admin:connectors" }, { scope: "documents:read unknown:write" },
    { role: "admin" }, { approval_grants: ["*"] }, { approvals: ["rebuild_index"] },
  ])("denies unsafe JWT claims: %j", async override => {
    await expect(authenticateRequest(`Bearer ${await mint({ ...claims, ...override })}`, config)).rejects.toThrow();
  });

  it("rejects wrong signature and algorithm", async () => {
    await expect(authenticateRequest(`Bearer ${await mint(claims, "HS256", "untrusted-secret")}`, config)).rejects.toThrow();
    await expect(authenticateRequest(`Bearer ${await mint(claims, "HS384")}`, config)).rejects.toThrow();
  });

  it("does not allow programmatic voice servers to fall back to development identity", () => {
    expect(() => createDataRoomMcpServer({ ragCoreBaseUrl: env.RAG_CORE_BASE_URL, voicePolicy: policy })).toThrow();
  });
});

describe("voice input, response and fixture validation", () => {
  it("bounds input and rejects invented filters or extra authority fields", () => {
    for (const data of [{ query: "x", top_k: 6 }, { query: "x", year: 2025 },
      { query: "x", semantic: true }, { query: "x", workspace_id: "other" }, { query: "x".repeat(2001) }]) {
      expect(VoiceSearchInputSchema.safeParse(data).success).toBe(false);
    }
    expect(VoiceVerifyInputSchema.safeParse({ chunk_id: "x", quote: "q", document: "spoofed" }).success).toBe(false);
    expect(VoiceVerifyInputSchema.safeParse({ chunk_id: "x", quote: "q".repeat(5001) }).success).toBe(false);
  });

  it("rejects fixture drift after startup", () => {
    const target = resolve(temporary, "index/chunks.json");
    const original = readFileSync(target);
    try {
      writeFileSync(target, original.toString().replace("Alder", "Other"));
      expect(() => policy.assertFixture()).toThrow();
    } finally { writeFileSync(target, original); }
    const extra = resolve(temporary, "data/private.txt");
    try {
      writeFileSync(extra, "synthetic negative-test sentinel");
      expect(() => policy.assertFixture()).toThrow();
    } finally { rmSync(extra); }
  });

  it("refuses ordinary upstreams before retrieval", async () => {
    const client = new RagCoreClient(env.RAG_CORE_BASE_URL, "test", access, true);
    vi.spyOn(client, "getHealth").mockResolvedValue({ ok: true, correlation_id: "test", data: { status: "ok" } });
    const invoke = vi.fn();
    const result = await policy.read("search_data_room", { query: "risk" }, client, access, "test", invoke);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects unknown or out-of-claim chunks before any upstream call", async () => {
    const client = new RagCoreClient(env.RAG_CORE_BASE_URL);
    const health = vi.spyOn(client, "getHealth");
    for (const id of ["private-1", "voice-notes-2024-1"]) {
      const result = await policy.read("verify_citation", { chunk_id: id, quote: "x" }, client,
        { ...access, allowedDocumentIds: ["synthetic_contracts_2025.txt"] }, "test", vi.fn());
      expect(result.ok).toBe(false);
    }
    expect(health).not.toHaveBeenCalled();
  });

  it.each([
    { results: [{ chunk_id: "private-1", doc: "private.txt", text: "SECRET" }] },
    { results: [{ chunk_id: "voice-contracts-2025-1", doc: "synthetic_contracts_2025.txt", text: "SECRET", score: 1 }] },
    { results: [{ text: "SECRET" }] }, { results: "SECRET" },
  ])("fails closed on malformed/poisoned search envelopes", async data => {
    const client = healthyClient();
    const result = await policy.read("search_data_room", { query: "risk" }, client, access, "test", async () => ({
      ok: true, correlation_id: "SECRET", data: { mode: "lexical", query: "risk", ...data },
    }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("rejects a false-positive upstream verification and strips error details", async () => {
    const client = healthyClient();
    const input = { chunk_id: "voice-contracts-2025-1", quote: "invented profit" };
    const result = await policy.read("verify_citation", input, client, access, "test", async () => ({
      ok: true, correlation_id: "test", data: { ...input, verified: true },
    }));
    expect(result.ok).toBe(false);
    const failed = await policy.read("verify_citation", input, client, access, "test", async () => {
      throw new Error("SECRET token and excerpt");
    });
    expect(JSON.stringify(failed)).not.toContain("SECRET");
  });

  it("bounds upstream response size and rejects bad HTTP envelopes without diagnostics", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("SECRET not JSON"));
    const client = new RagCoreClient(env.RAG_CORE_BASE_URL, "test", access, true);
    await expect(client.getHealth()).rejects.toThrow("Voice upstream request failed.");
    const options = fetcher.mock.calls[0]![1]!;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe("error");
    fetcher.mockResolvedValue(new Response("x".repeat(65537)));
    await expect(client.getHealth()).rejects.toThrow("Voice upstream request failed.");
    fetcher.mockResolvedValue(new Response('{"ok":true,"correlation_id":"x","data":{}}', { status: 500 }));
    await expect(client.getHealth()).rejects.toThrow("Voice upstream request failed.");
    fetcher.mockRejectedValue(new DOMException("SECRET timeout context", "TimeoutError"));
    await expect(client.getHealth()).rejects.toThrow("Voice upstream request failed.");
  });

  it("projects valid evidence onto approved metadata and rechecks expiry", async () => {
    const client = healthyClient();
    const input = { chunk_id: "voice-contracts-2025-1", quote: "SYNTHETIC DEMONSTRATION ONLY." };
    const invoke = vi.fn(async () => ({ ok: true as const, correlation_id: "untrusted", data: {
      ...input, verified: true, document: "SECRET.pdf", page_label: "999", extra: "SECRET",
    } }));
    const result = await policy.read("verify_citation", input, client, access, "trusted", invoke);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.correlation_id).toBe("trusted");
    if (result.ok) expect(result.data).toMatchObject({ document: "synthetic_contracts_2025.txt", page_label: null });
    invoke.mockClear();
    const expired = await policy.read("verify_citation", input, client, { ...access, expiresAt: 1 }, "trusted", invoke);
    expect(expired.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

function healthyClient(): RagCoreClient {
  const client = new RagCoreClient(env.RAG_CORE_BASE_URL);
  vi.spyOn(client, "getHealth").mockResolvedValue({ ok: true, correlation_id: "test", data: {
    voice_fixture: policy.fingerprint, workspace_id: policy.workspaceId, read_only: true,
  } });
  return client;
}
async function mint(payload: Record<string, unknown>, algorithm = "HS256", key = secret): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm }).sign(new TextEncoder().encode(key));
}
