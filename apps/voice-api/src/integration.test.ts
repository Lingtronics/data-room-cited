import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceApi, type AuditEvent } from "./app.js";
import { loadVoiceConfig, type EnabledConfig } from "./config.js";
import { ElevenLabsSessions } from "./elevenLabs.js";
import { McpEvidence } from "./mcpEvidence.js";
import { apiKey, configEnv, item, repoRoot, response, signedUrl, tokenFor } from "./testSupport.js";

describe("voice API → authenticated MCP → existing Python fixture integration", () => {
  let temporary: string;
  let core: ChildProcess | undefined;
  let gateway: ChildProcess | undefined;
  let app: ReturnType<typeof createVoiceApi> | undefined;
  let config: EnabledConfig;
  let base: string;
  let logs = "";
  let originalIndex: Buffer;
  const audit: AuditEvent[] = [];
  const secret = randomBytes(32).toString("hex");
  const provider = vi.fn<typeof fetch>(async () => response({ signed_url: signedUrl }));

  beforeAll(async () => {
    temporary = mkdtempSync(resolve(tmpdir(), "drc-voice-api-"));
    cpSync(resolve(repoRoot, "fixtures/voice/data"), resolve(temporary, "data"), { recursive: true });
    cpSync(resolve(repoRoot, "fixtures/voice/index"), resolve(temporary, "index"), { recursive: true });
    originalIndex = readFileSync(resolve(temporary, "index/chunks.json"));
    const corePort = await freePort();
    const gatewayPort = await freePort();
    const apiPort = await freePort();
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const coreBase = `http://127.0.0.1:${corePort}`;
    base = `http://127.0.0.1:${apiPort}`;
    const env = { ...process.env, VOICE_FEATURE_ENABLED: "true", VOICE_READ_ONLY_DEMO: "true",
      VOICE_FIXTURE_DATA_DIR: resolve(temporary, "data"), DATA_DIR: resolve(temporary, "data"),
      VOICE_FIXTURE_INDEX_DIR: resolve(temporary, "index"), INDEX_DIR: resolve(temporary, "index"),
      EXPORT_DIR: resolve(temporary, "exports"), DOCUMENT_SOURCE_TYPE: "local",
      MCP_AUTH_REQUIRED: "true", MCP_ALLOW_DEV_TOKENS: "false", MCP_JWKS_URL: "",
      MCP_AUTH_ISSUER: "voice-tests", MCP_AUTH_AUDIENCE: `${gatewayBase}/mcp`,
      MCP_DEV_JWT_SECRET: secret, MCP_GATEWAY_PORT: String(gatewayPort), MCP_GATEWAY_HOST: "127.0.0.1",
      RAG_CORE_HOST: "127.0.0.1", RAG_CORE_PORT: String(corePort), RAG_CORE_BASE_URL: coreBase,
      MCP_DEFAULT_SCOPES: "documents:read,citations:verify", OTEL_SDK_DISABLED: "true",
      DEEPSEEK_API_KEY: "", ELEVENLABS_API_KEY: "", PYTHONUNBUFFERED: "1" };
    const capture = (child: ChildProcess) => {
      child.stdout?.on("data", bytes => { logs += String(bytes); });
      child.stderr?.on("data", bytes => { logs += String(bytes); });
    };
    const python = process.env.RAG_CORE_PYTHON ?? (process.platform === "win32" ? resolve(repoRoot, ".venv/Scripts/python.exe") : "python");
    core = spawn(python, ["scripts/run_voice_core.py"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    capture(core);
    await healthy(coreBase, core);
    gateway = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: resolve(repoRoot, "apps/mcp-server"), env, stdio: ["ignore", "pipe", "pipe"] });
    capture(gateway);
    await healthy(gatewayBase, gateway);
    config = loadVoiceConfig({ ...configEnv(), VOICE_API_PORT: String(apiPort),
      VOICE_MCP_BASE_URL: `${gatewayBase}/mcp`, VOICE_FIXTURE_DATA_DIR: resolve(temporary, "data"),
      VOICE_FIXTURE_INDEX_DIR: resolve(temporary, "index") }) as EnabledConfig;
    config.serviceToken = await tokenFor(config, {}, new TextEncoder().encode(secret));
    app = createVoiceApi(config, { sessions: new ElevenLabsSessions(config, provider),
      evidence: new McpEvidence(config), audit: event => { audit.push(event); } });
    await app.start();
  }, 30_000);

  afterAll(async () => {
    if (app?.server.listening) await new Promise<void>(done => {
      app!.server.close(() => done()); app!.server.closeAllConnections();
    });
    for (const child of [gateway, core]) {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>(done => child.once("exit", () => done()));
        child.kill(); await exited;
      }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown) {
    const result = await fetch(`${base}/api/voice/${path}`, { method: "POST",
      headers: { origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  }
  it("returns only MCP-verified fixture metadata and rejects a fabricated quote", async () => {
    const result = await post("evidence/verify", { items: [item, { ...item, quote: "Fabricated revenue 900 billion" }] });
    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([
      { ...item, verified: true, document: "synthetic_contracts_2025.txt", page_label: null, section_title: "Synthetic contracts, 2025" },
      { chunk_id: item.chunk_id, verified: false },
    ]);
  });
  it("denies unknown IDs and extra fields instead of returning valid evidence", async () => {
    const unknown = await post("evidence/verify", { items: [{ ...item, chunk_id: "private-doc-chunk" }] });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.code).toBe("evidence_not_allowed");
    expect((await post("evidence/verify", { items: [{ ...item, document: "private.txt", verified: true }] })).status).toBe(400);
  });
  it("honors exact document restrictions in a signed service token", async () => {
    const restricted = { ...config, serviceToken: await tokenFor(config,
      { document_ids: ["synthetic_contracts_2025.txt"] }, new TextEncoder().encode(secret)) };
    const evidence = new McpEvidence(restricted);
    await expect(evidence.verify([item])).resolves.toMatchObject([{ verified: true }]);
    await expect(evidence.verify([{ ...item, chunk_id: "voice-notes-2024-1" }])).rejects.toMatchObject({ code: "evidence_not_allowed" });
  });
  it("requires the gateway to validate the token signature and issuer", async () => {
    for (const serviceToken of [await tokenFor(config), await tokenFor(config, { iss: "wrong" }, new TextEncoder().encode(secret))]) {
      const invalid = createVoiceApi({ ...config, serviceToken });
      await expect(invalid.start()).rejects.toMatchObject({ code: "mcp_unavailable" });
      expect(invalid.server.listening).toBe(false);
    }
  });
  it("checks the real MCP profile before asking the mocked provider for a URL", async () => {
    const result = await post("session", {});
    expect(result.status).toBe(200);
    expect(result.body.signed_url).toBe(signedUrl);
    expect(provider).toHaveBeenCalledOnce();
    expect(readFileSync(resolve(temporary, "index/chunks.json"))).toEqual(originalIndex);
  });
  it("fails closed after fixture mutation and makes no provider request", async () => {
    const target = resolve(temporary, "index/chunks.json");
    try {
      writeFileSync(target, originalIndex.toString().replace("Alder", "Other"));
      const result = await post("evidence/verify", { items: [item] });
      expect(result.status).toBe(503);
      expect(JSON.stringify(result.body)).not.toContain('"verified":true');
      expect((await post("session", {})).status).toBe(503);
      expect(provider).toHaveBeenCalledOnce();
      const health = await fetch(new URL("/health", config.mcpUrl));
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ error: { code: "voice_fixture_unavailable" } });
    } finally { writeFileSync(target, originalIndex); }
  });
  it("leaves index unchanged and keeps secrets, signed URLs and excerpts out of diagnostics", () => {
    const diagnostics = logs + JSON.stringify(audit);
    for (const value of [apiKey, signedUrl, "private-signature-sentinel", config.serviceToken, secret,
      item.quote, "Fabricated revenue 900 billion", "private-doc-chunk"]) expect(diagnostics).not.toContain(value);
    expect(readFileSync(resolve(temporary, "index/chunks.json"))).toEqual(originalIndex);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback test port");
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}
async function healthy(base: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture service exited (${child.exitCode}) before health check.`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error("Local fixture service did not start in ten seconds.");
}
