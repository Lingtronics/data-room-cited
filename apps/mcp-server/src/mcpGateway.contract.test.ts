import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataRoomMcpServer } from "./mcpServer.js";
import { type ApiEnvelope } from "./schemas.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const hasLocalIndex =
  existsSync(resolve(repoRoot, "index", "chunks.json")) &&
  existsSync(resolve(repoRoot, "index", "embeddings.npy"));

const contractDescribe = describe.skipIf(!hasLocalIndex);

contractDescribe("TypeScript MCP gateway contracts", () => {
  const port = 8766;
  const baseUrl = `http://127.0.0.1:${port}`;
  let ragCore: ChildProcess | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    const pythonExe =
      process.env.RAG_CORE_PYTHON ?? resolve(repoRoot, ".venv", "Scripts", "python.exe");
    ragCore = spawn(
      pythonExe,
      [
        "-m",
        "uvicorn",
        "app:app",
        "--app-dir",
        resolve(repoRoot, "services", "rag-core"),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForHealth(`${baseUrl}/health`);

    const mcpServer = createDataRoomMcpServer({
      ragCoreBaseUrl: baseUrl,
      scopes: ["documents:read", "citations:verify"],
      correlationId: "contract-test",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "contract-test-client", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    if (ragCore && !ragCore.killed) {
      ragCore.kill();
    }
  });

  it("discovers tools, resources, and prompts", async () => {
    const tools = await requireClient().listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(
      expect.arrayContaining([
        "search_data_room",
        "verify_citation",
        "find_supporting_evidence",
        "get_asset_lineage",
        "list_document_source_documents",
        "sync_document_source",
        "rebuild_index",
        "export_powerpoint_outline",
      ]),
    );

    const resourceTemplates = await requireClient().listResourceTemplates();
    expect(resourceTemplates.resourceTemplates.map(resource => resource.uriTemplate)).toEqual(
      expect.arrayContaining([
        "dataroom://documents/{document_id}",
        "dataroom://chunks/{chunk_id}",
        "dataroom://catalogue/{asset_id}",
      ]),
    );

    const prompts = await requireClient().listPrompts();
    expect(prompts.prompts.map(prompt => prompt.name)).toEqual(
      expect.arrayContaining([
        "diligence-risk-review",
        "contract-concentration-analysis",
        "evidence-gap-assessment",
      ]),
    );
  });

  it("matches Python API output for search_data_room", async () => {
    const args = { query: "contract risks", top_k: 2, semantic: false };
    const mcpEnvelope = await callToolEnvelope("search_data_room", args);
    const apiEnvelope = await apiEnvelopeFor("retrieval/search", {
      method: "POST",
      body: JSON.stringify({ query: args.query, top_k: args.top_k, semantic: args.semantic }),
    });

    expect(mcpEnvelope).toEqual(apiEnvelope);
  });

  it("matches Python API output for verify_citation", async () => {
    const search = await callToolEnvelope("search_data_room", {
      query: "contract risks",
      top_k: 1,
      semantic: false,
    });
    expect(search.ok).toBe(true);

    const firstResult = firstSearchResult(search);
    const quote = firstResult.text.slice(0, 80).trim();
    const args = { chunk_id: firstResult.chunk_id, quote };

    const mcpEnvelope = await callToolEnvelope("verify_citation", args);
    const apiEnvelope = await apiEnvelopeFor("citations/verify", {
      method: "POST",
      body: JSON.stringify(args),
    });

    expect(mcpEnvelope).toEqual(apiEnvelope);
  });

  it("matches Python API output for supporting evidence and asset lineage", async () => {
    const evidenceArgs = { query: "contract risks", limit: 2 };
    const mcpEvidence = await callToolEnvelope("find_supporting_evidence", evidenceArgs);
    const apiEvidence = await apiEnvelopeFor(
      `graph/evidence?${new URLSearchParams({
        query: evidenceArgs.query,
        limit: String(evidenceArgs.limit),
      })}`,
    );
    expect(mcpEvidence).toEqual(apiEvidence);

    const search = await callToolEnvelope("search_data_room", {
      query: "contract risks",
      top_k: 1,
      semantic: false,
    });
    const assetId = `chunk:${firstSearchResult(search).chunk_id}`;
    const lineageArgs = { asset_id: assetId, depth: 1 };
    const mcpLineage = await callToolEnvelope("get_asset_lineage", lineageArgs);
    const apiLineage = await apiEnvelopeFor(
      `catalogue/assets/${encodeURIComponent(assetId)}/lineage?${new URLSearchParams({
        depth: "1",
      })}`,
    );
    expect(mcpLineage).toEqual(apiLineage);
  });

  it("rejects write tools for read-only scopes before reaching Python", async () => {
    const result = (await requireClient().callTool({
      name: "rebuild_index",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ApiEnvelope;
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("insufficient_scope");
    }
  });

  async function callToolEnvelope(name: string, args: Record<string, unknown>): Promise<ApiEnvelope> {
    const result = (await requireClient().callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    return result.structuredContent as ApiEnvelope;
  }

  async function apiEnvelopeFor(path: string, init: RequestInit = {}): Promise<ApiEnvelope> {
    const response = await fetch(`${baseUrl}/${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-correlation-id": "contract-test",
        ...init.headers,
      },
    });
    return (await response.json()) as ApiEnvelope;
  }

  function requireClient(): Client {
    if (!client) {
      throw new Error("MCP client not initialised.");
    }
    return client;
  }
});

async function waitForHealth(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`RAG core did not become healthy: ${String(lastError)}`);
}

function firstSearchResult(envelope: ApiEnvelope): {
  chunk_id: string;
  text: string;
} {
  if (!envelope.ok) {
    throw new Error(envelope.error.message);
  }
  const data = envelope.data as { results?: Array<{ chunk_id: string; text: string }> };
  const result = data.results?.[0];
  if (!result) {
    throw new Error("Expected search_data_room to return at least one result.");
  }
  return result;
}
