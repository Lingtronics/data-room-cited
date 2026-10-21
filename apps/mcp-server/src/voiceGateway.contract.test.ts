import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const python = process.env.RAG_CORE_PYTHON ?? (process.platform === "win32" ? resolve(root, ".venv/Scripts/python.exe") : "python");

describe("voice HTTP MCP and Python fixture security contract", () => {
  let temporary: string;
  let gateway: ChildProcess | undefined;
  let externalGateway: ChildProcess | undefined;
  let externalBase: string;
  let core: ChildProcess | undefined;
  let base: string;
  let coreBase: string;
  let token: string;
  let originalIndex: Buffer;
  let logs = "";
  const secret = randomBytes(32).toString("hex");
  const documents = ["synthetic_contracts_2025.txt", "synthetic_risk_review_2025.txt", "synthetic_notes_2024.txt"];

  async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({
      sub: "voice-demo-service", iss: "voice-contract-test", aud: `${base}/mcp`,
      exp: Math.floor(Date.now() / 1000) + 300, workspace_id: "voice-synthetic-v1",
      role: "reader", scope: "documents:read citations:verify", document_ids: documents,
      ...overrides,
    }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
  }

  beforeAll(async () => {
    temporary = mkdtempSync(resolve(tmpdir(), "drc-voice-contract-"));
    cpSync(resolve(root, "fixtures/voice/data"), resolve(temporary, "data"), { recursive: true });
    cpSync(resolve(root, "fixtures/voice/index"), resolve(temporary, "index"), { recursive: true });
    originalIndex = readFileSync(resolve(temporary, "index/chunks.json"));
    const corePort = await freePort();
    const gatewayPort = await freePort();
    base = `http://127.0.0.1:${gatewayPort}`;
    coreBase = `http://127.0.0.1:${corePort}`;
    const env = {
      ...process.env, VOICE_FEATURE_ENABLED: "true", VOICE_READ_ONLY_DEMO: "true",
      VOICE_FIXTURE_DATA_DIR: resolve(temporary, "data"), DATA_DIR: resolve(temporary, "data"),
      VOICE_FIXTURE_INDEX_DIR: resolve(temporary, "index"), INDEX_DIR: resolve(temporary, "index"),
      EXPORT_DIR: resolve(temporary, "exports"), DOCUMENT_SOURCE_TYPE: "local",
      MCP_AUTH_REQUIRED: "true", MCP_ALLOW_DEV_TOKENS: "false", MCP_JWKS_URL: "",
      MCP_AUTH_ISSUER: "voice-contract-test", MCP_AUTH_AUDIENCE: `${base}/mcp`,
      MCP_DEV_JWT_SECRET: secret, MCP_GATEWAY_PORT: String(gatewayPort), MCP_GATEWAY_HOST: "127.0.0.1",
      RAG_CORE_HOST: "127.0.0.1", RAG_CORE_PORT: String(corePort), RAG_CORE_BASE_URL: coreBase,
      MCP_DEFAULT_SCOPES: "documents:read,citations:verify", OTEL_SDK_DISABLED: "true",
      DEEPSEEK_API_KEY: "", ELEVENLABS_API_KEY: "", PYTHONUNBUFFERED: "1",
    };
    const capture = (child: ChildProcess) => {
      child.stdout?.on("data", bytes => { logs += String(bytes); });
      child.stderr?.on("data", bytes => { logs += String(bytes); });
    };
    core = spawn(python, ["scripts/run_voice_core.py"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    capture(core);
    await healthy(coreBase, core);
    gateway = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: resolve(root, "apps/mcp-server"), env, stdio: ["ignore", "pipe", "pipe"],
    });
    capture(gateway);
    await healthy(base, gateway);
    externalBase = `http://127.0.0.1:${await freePort()}`;
    externalGateway = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: resolve(root, "apps/mcp-server"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, MCP_GATEWAY_PORT: new URL(externalBase).port,
        VOICE_MCP_EXTERNAL_ORIGIN: "https://voice-demo.example.test",
        VOICE_MCP_EXTERNAL_EXPIRES_AT: new Date(Date.now() + 300_000).toISOString() },
    });
    capture(externalGateway);
    await healthy(externalBase, externalGateway);
    token = await mint();
  }, 30_000);

  afterAll(async () => {
    for (const child of [externalGateway, gateway, core]) {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>(done => child.once("exit", () => done()));
        child.kill();
        await exited;
      }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  it("exposes exactly two read tools over real Streamable HTTP", async () => {
    const { response, body } = await rpc("tools/list");
    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["search_data_room", "verify_citation"]);
  });

  it.each(["resources/list", "resources/templates/list", "prompts/list"])("cannot enumerate %s", async method => {
    const { body } = await rpc(method);
    expect(body.error?.code).toBe(-32601);
  });

  it.each([
    ["resources/read", { uri: "dataroom://chunks/voice-contracts-2025-1" }],
    ["resources/read", { uri: "dataroom://evals/latest" }],
    ["prompts/get", { name: "diligence-risk-review" }],
  ])("denies direct %s calls", async (method, params) => {
    expect((await rpc(method, params)).body.error).toBeDefined();
  });

  it.each(["rebuild_index", "sync_document_source", "export_powerpoint_outline", "find_supporting_evidence", "get_asset_lineage", "list_document_source_documents", "unknown_tool"])("cannot invoke %s", async name => {
    const { body } = await rpc("tools/call", { name, arguments: {} });
    expect(!!body.error || body.result?.isError === true).toBe(true);
    expect(readFileSync(resolve(temporary, "index/chunks.json"))).toEqual(originalIndex);
  });

  it("retrieves and verifies through the existing Python functions", async () => {
    const result = await call("search_data_room", { query: "automatic renewal" });
    expect(result.ok).toBe(true);
    expect(result.data.mode).toBe("lexical");
    const first = result.data.results[0];
    expect(documents).toContain(first.doc);
    const verified = await call("verify_citation", { chunk_id: first.chunk_id, quote: first.text });
    expect(verified.data.verified).toBe(true);
    expect(verified.data.document).toBe(first.doc);
    expect(verified.data.page_label).toBeNull();
    const wrong = await call("verify_citation", { chunk_id: first.chunk_id, quote: "invented revenue" });
    expect(wrong.data.verified).toBe(false);
  });

  it("honors exact signed document claims for search and guessed verification IDs", async () => {
    const restricted = await mint({ document_ids: [documents[0]] });
    const result = await call("search_data_room", { query: "Birch pilot" }, restricted);
    expect(result.data.results).toEqual([]);
    for (const chunk_id of ["voice-notes-2024-1", "unknown-private-chunk"]) {
      const denied = await call("verify_citation", { chunk_id, quote: "SYNTHETIC" }, restricted);
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("forbidden_document");
      expect(JSON.stringify(denied)).not.toContain("Birch");
    }
  });

  it("rejects absent, invalid, expired, wrong-issuer and wrong-audience tokens", async () => {
    for (const bad of ["", "read", "invalid", await mint({ exp: 1 }), await mint({ exp: undefined }),
      await mint({ aud: "wrong" }), await mint({ iss: "wrong" })]) {
      expect((await rpc("tools/list", {}, bad)).response.status).toBe(401);
    }
  });

  it("denies cross-workspace, write/admin claims, approvals and missing scopes", async () => {
    for (const override of [{ workspace_id: "other" }, { scope: "admin:connectors" },
      { scope: "documents:read index:write" }, { approval_grants: ["*"] }, { document_ids: [] }]) {
      expect((await rpc("tools/list", {}, await mint(override))).response.status).toBe(403);
    }
    const noRead = await mint({ scope: "citations:verify" });
    expect((await call("search_data_room", { query: "renewal" }, noRead)).error.code).toBe("insufficient_scope");
    const noVerify = await mint({ scope: "documents:read" });
    expect((await call("verify_citation", { chunk_id: "voice-contracts-2025-1", quote: "SYNTHETIC" }, noVerify)).error.code).toBe("insufficient_scope");
  });

  it("rejects extra fields, excessive top_k and semantic model requests", async () => {
    for (const args of [{ query: "x", year: 2025 }, { query: "x", top_k: 6 },
      { query: "x", semantic: true }, { query: "x".repeat(2001) }]) {
      const { body } = await rpc("tools/call", { name: "search_data_room", arguments: args });
      expect(body.result?.isError || !!body.error).toBe(true);
    }
  });

  it("blocks spoofed Origin and Host", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { host: "evil.test" }]) {
      // node:http deliberately permits a forged Host; fetch can rewrite it.
      const status = await new Promise<number | undefined>((done, reject) => {
        const req = httpRequest(`${base}/mcp`, { method: "POST", headers: {
          authorization: `Bearer ${token}`, accept: "application/json, text/event-stream",
          "content-type": "application/json", ...headers,
        } }, res => { res.resume(); done(res.statusCode); });
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      });
      expect(status).toBe(403);
    }
  });

  it("core denies direct write/metadata routes and modified fixtures", async () => {
    const denied = await fetch(`${coreBase}/index/rebuild`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(403);
    const target = resolve(temporary, "index/chunks.json");
    try {
      writeFileSync(target, originalIndex.toString().replace("Alder", "Other"));
      expect((await fetch(`${coreBase}/health`)).status).toBe(503);
      // Authenticated requests must fail closed even after the gateway started.
      const { response, body } = await rpc("tools/call", { name: "search_data_room", arguments: { query: "renewal" } });
      expect(response.status >= 400 || !!body.error || body.result?.isError).toBeTruthy();
      const remote = await externalRpc("/mcp", "tools/call", { name: "search_data_room", arguments: { query: "renewal" } });
      expect(remote.status >= 400 || !!remote.body.error || remote.body.result?.isError).toBeTruthy();
    } finally { writeFileSync(target, originalIndex); }
  });

  it("accepts only authenticated read tools through the simulated trusted HTTPS ingress", async () => {
    const discovery = await externalRpc("/mcp", "tools/list");
    expect(discovery.status).toBe(200);
    expect(discovery.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["search_data_room", "verify_citation"]);
    expect(discovery.headers["cache-control"]).toContain("no-store");
    const verified = await externalRpc("/mcp", "tools/call", { name: "verify_citation", arguments: {
      chunk_id: "voice-contracts-2025-1", quote: "SYNTHETIC DEMONSTRATION ONLY." } });
    expect(verified.body.result.structuredContent.data).toMatchObject({ verified: true, document: documents[0], page_label: null });
    for (const method of ["resources/list", "prompts/list"]) expect((await externalRpc("/mcp", method)).body.error).toBeDefined();
    const denied = await externalRpc("/mcp", "tools/call", { name: "rebuild_index", arguments: {} });
    expect(!!denied.body.error || denied.body.result?.isError).toBe(true);
    expect(readFileSync(resolve(temporary, "index/chunks.json"))).toEqual(originalIndex);
  });

  it("does not treat tunnel headers as authentication or document authority", async () => {
    for (const bearer of ["", "read", "invalid", await mint({ exp: 1 }), await mint({ aud: "wrong" })])
      expect((await externalRpc("/mcp", "tools/list", {}, bearer)).status).toBe(401);
    expect((await externalRpc("/mcp", "tools/list", {}, await mint({ scope: "documents:read index:write" }))).status).toBe(403);
    const narrow = await mint({ document_ids: [documents[0]] });
    const outside = await externalRpc("/mcp", "tools/call", { name: "verify_citation", arguments: { chunk_id: "voice-notes-2024-1", quote: "Birch" } }, narrow);
    expect(outside.body.result.structuredContent.error.code).toBe("forbidden_document");
    expect(JSON.stringify(outside.body)).not.toContain("expires at the end of 2024");
  });

  it.each(["/health", "/api/voice/session", "/", "/mcp?token=PRIVATE", "/mcp/"])("never exposes %s through the simulated tunnel", async path => {
    expect((await externalRpc(path, "tools/list")).status).toBe(403);
  });

  it("rejects proxy rewriting, Origin spoofing and unexpected hosts", async () => {
    for (const headers of [{ host: "evil.test" }, { origin: "https://evil.test" },
      { host: `127.0.0.1:${new URL(externalBase).port}` }, { "x-forwarded-proto": "http" }, { "x-forwarded-host": "evil.test" }]) {
      expect((await externalRpc("/mcp", "tools/list", {}, token, headers)).status).toBe(403);
    }
    expect((await externalRpc("/mcp", "tools/list", {}, token, {}, base)).status).toBe(403);
  });

  it("rejects oversized declared and malformed bodies without source or credential diagnostics", async () => {
    const oversized = await externalRpc("/mcp", "tools/list", {}, token, { "content-length": "65537" });
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toContain(token);
    const malformed = await externalRpc("/mcp", "tools/list", {}, token, {}, externalBase, "PRIVATE invalid JSON");
    expect(malformed.status).toBe(400); expect(JSON.stringify(malformed.body)).not.toContain("PRIVATE");
  });

  it("closes a stalled authenticated upload within the deadline and releases capacity", async () => {
    const started = Date.now();
    await new Promise<void>((done, reject) => {
      const req = httpRequest(`${externalBase}/mcp`, { method: "POST", headers: {
        host: "voice-demo.example.test", "x-forwarded-proto": "https", authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": "100",
      } }, res => { res.resume(); reject(new Error("A stalled upload must not produce an MCP result.")); });
      req.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? done() : reject(error));
      req.write("{");
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - started).toBeLessThan(18_000);
    expect((await externalRpc("/mcp", "tools/list")).status).toBe(200);
  }, 20_000);

  it("does not put tokens, source quotes or questions in process logs", () => {
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("invented revenue");
    expect(logs).not.toContain("ninety days before expiry");
    expect(logs).not.toContain("automatic renewal");
  });

  it("validates the M4 expected source excerpts against real Python verification (not agent behavior)", async () => {
    const cases = JSON.parse(readFileSync(resolve(root, "evals/voice_m4_cases.json"), "utf8")) as {
      cases: { id: string; sources: { chunk_id: string; quote: string }[] }[] };
    expect(cases.cases).toHaveLength(12);
    expect(new Set(cases.cases.map(item => item.id)).size).toBe(12);
    for (const item of cases.cases) for (const source of item.sources) {
      const result = await externalRpc("/mcp", "tools/call", { name: "verify_citation", arguments: source });
      expect(result.body.result.structuredContent.data.verified, item.id).toBe(true);
    }
  });

  async function rpc(method: string, params: unknown = {}, bearer = token) {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
      accept: "application/json, text/event-stream", "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text();
    // The pinned SDK's 2025-compatible fallback returns SSE, even with modern
    // responseMode=json. Assert the wire response rather than assuming JSON.
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6) ?? "{}"
      : text;
    return { response, body: JSON.parse(json) as any };
  }
  async function call(name: string, args: unknown, bearer = token) {
    const { body } = await rpc("tools/call", { name, arguments: args }, bearer);
    expect(body.result).toBeDefined();
    return body.result.structuredContent;
  }

  async function externalRpc(path: string, method: string, params: unknown = {}, bearer = token,
    headers: Record<string, string> = {}, target = externalBase, rawBody?: string) {
    return new Promise<{ status: number; body: any; headers: import("node:http").IncomingHttpHeaders }>((done, reject) => {
      const req = httpRequest(`${target}${path}`, { method: "POST", headers: {
        host: "voice-demo.example.test", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.1",
        accept: "application/json, text/event-stream", "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers,
      } }, res => {
        let data = ""; res.on("data", chunk => { data += String(chunk); });
        res.on("end", () => {
          try {
            const payload = res.headers["content-type"]?.includes("text/event-stream")
              ? data.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6) ?? "{}" : data;
            done({ status: res.statusCode!, body: JSON.parse(payload), headers: res.headers });
          } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
  }
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
    if (child.exitCode !== null) throw new Error(`Test service exited (${child.exitCode}) before health check.`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error("Local fixture service did not start in ten seconds.");
}
