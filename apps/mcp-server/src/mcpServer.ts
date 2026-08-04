import { randomUUID } from "node:crypto";

import { McpServer, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";

import { ALL_SCOPES, type Scope } from "./config.js";
import { RagCoreClient } from "./ragCoreClient.js";
import {
  ContractConcentrationPromptArgsSchema,
  EvidenceGapPromptArgsSchema,
  ExportPowerPointOutlineInputSchema,
  FindSupportingEvidenceInputSchema,
  GetAssetLineageInputSchema,
  RebuildIndexInputSchema,
  RiskReviewPromptArgsSchema,
  SearchDataRoomInputSchema,
  ToolEnvelopeSchema,
  VerifyCitationInputSchema,
  type ApiEnvelope,
} from "./schemas.js";
import { hasScope } from "./scopes.js";

export type DataRoomMcpServerOptions = {
  ragCoreBaseUrl: string;
  scopes?: string[];
  correlationId?: string;
};

export function createDataRoomMcpServer(options: DataRoomMcpServerOptions): McpServer {
  const correlationId = options.correlationId ?? randomUUID();
  const scopes = options.scopes ?? ["documents:read", "citations:verify"];
  const client = new RagCoreClient(options.ragCoreBaseUrl, correlationId);
  const server = new McpServer(
    {
      name: "data-room-cited-typescript-gateway",
      version: "1.0.0",
    },
    {
      instructions:
        "Use this gateway to access Data Room Cited evidence capabilities. The Python RAG core remains the source of truth; this MCP server validates requests, enforces scopes, and returns typed recoverable errors.",
    },
  );

  server.registerTool(
    "search_data_room",
    {
      title: "Search Data Room",
      description: "Search trusted Python retrieval results through the FastAPI RAG core.",
      inputSchema: SearchDataRoomInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async input =>
      withScope(correlationId, scopes, "documents:read", () => client.searchDataRoom(input)),
  );

  server.registerTool(
    "verify_citation",
    {
      title: "Verify Citation",
      description: "Verify that a quote appears in the original source text for a chunk.",
      inputSchema: VerifyCitationInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async input =>
      withScope(correlationId, scopes, "citations:verify", () => client.verifyCitation(input)),
  );

  server.registerTool(
    "find_supporting_evidence",
    {
      title: "Find Supporting Evidence",
      description: "Find graph claim nodes and source provenance for a topic.",
      inputSchema: FindSupportingEvidenceInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async input =>
      withScope(correlationId, scopes, "documents:read", () => client.findSupportingEvidence(input)),
  );

  server.registerTool(
    "get_asset_lineage",
    {
      title: "Get Asset Lineage",
      description: "Trace catalogue lineage for a document, chunk, or generated artifact asset.",
      inputSchema: GetAssetLineageInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async input =>
      withScope(correlationId, scopes, "documents:read", () => client.getAssetLineage(input)),
  );

  server.registerTool(
    "rebuild_index",
    {
      title: "Rebuild Index",
      description: "Rebuild the Python vector index, catalogue, semantic index, and knowledge graph.",
      inputSchema: RebuildIndexInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async input => withScope(correlationId, scopes, "index:write", () => client.rebuildIndex(input)),
  );

  server.registerTool(
    "export_powerpoint_outline",
    {
      title: "Export PowerPoint Outline",
      description: "Save a cited Markdown PowerPoint outline via the Python core.",
      inputSchema: ExportPowerPointOutlineInputSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async input =>
      withScope(correlationId, scopes, "exports:write", () =>
        client.exportPowerPointOutline(input),
      ),
  );

  registerResources(server, client, correlationId, scopes);
  registerPrompts(server);
  return server;
}

function registerResources(
  server: McpServer,
  client: RagCoreClient,
  correlationId: string,
  scopes: string[],
): void {
  server.registerResource(
    "document",
    new ResourceTemplate("dataroom://documents/{document_id}", { list: undefined }),
    {
      title: "Data-room document catalogue asset",
      description: "Read one document asset from the Python catalogue.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      resourceFromEnvelope(
        uri.href,
        await readResourceEnvelope(correlationId, scopes, () =>
          client.getDocument(oneValue(variables.document_id)),
        ),
      ),
  );

  server.registerResource(
    "chunk",
    new ResourceTemplate("dataroom://chunks/{chunk_id}", { list: undefined }),
    {
      title: "Source chunk",
      description: "Read one indexed chunk from the Python RAG core.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      resourceFromEnvelope(
        uri.href,
        await readResourceEnvelope(correlationId, scopes, () => client.getChunk(oneValue(variables.chunk_id))),
      ),
  );

  server.registerResource(
    "catalogue-asset",
    new ResourceTemplate("dataroom://catalogue/{asset_id}", { list: undefined }),
    {
      title: "Catalogue asset",
      description: "Read one catalogue asset with governance metadata and lineage references.",
      mimeType: "application/json",
    },
    async (uri, variables) =>
      resourceFromEnvelope(
        uri.href,
        await readResourceEnvelope(correlationId, scopes, () =>
          client.getDataAsset(oneValue(variables.asset_id)),
        ),
      ),
  );

  server.registerResource(
    "latest-evals",
    "dataroom://evals/latest",
    {
      title: "Latest eval definitions",
      description: "Read the latest deterministic data-management eval cases.",
      mimeType: "application/json",
    },
    async uri =>
      resourceFromEnvelope(
        uri.href,
        await readResourceEnvelope(correlationId, scopes, () => client.getLatestEvals()),
      ),
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "diligence-risk-review",
    {
      title: "Diligence Risk Review",
      description: "Review source-backed risks and evidence gaps before a diligence readout.",
      argsSchema: RiskReviewPromptArgsSchema,
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Use search_data_room and find_supporting_evidence to prepare a cited diligence risk review focused on ${focus}. Verify every quote before using it.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "contract-concentration-analysis",
    {
      title: "Contract Concentration Analysis",
      description: "Analyze customer contract concentration and renewal or opt-out exposure.",
      argsSchema: ContractConcentrationPromptArgsSchema,
    },
    ({ threshold }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyze contract concentration using ${threshold}. Use search_data_room, get_asset_lineage if needed, and verify_citation before presenting evidence.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "evidence-gap-assessment",
    {
      title: "Evidence Gap Assessment",
      description: "Identify what the data room does not cover or leaves unclear.",
      argsSchema: EvidenceGapPromptArgsSchema,
    },
    ({ workstream }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Assess evidence gaps for ${workstream}. Use search_data_room, find_supporting_evidence, and resource reads. Separate verified evidence from missing or unclear coverage.`,
          },
        },
      ],
    }),
  );
}

async function withScope(
  correlationId: string,
  scopes: string[],
  requiredScope: Scope,
  fn: () => Promise<ApiEnvelope>,
): Promise<CallToolResult> {
  if (!hasScope(scopes, requiredScope)) {
    return envelopeToToolResult(
      {
        ok: false,
        correlation_id: correlationId,
        error: {
          code: "insufficient_scope",
          message: `Required scope '${requiredScope}'. Granted scopes: ${scopes.join(", ") || "none"}.`,
        },
      },
      true,
    );
  }
  try {
    const envelope = await fn();
    return envelopeToToolResult(envelope, !envelope.ok);
  } catch (error) {
    return envelopeToToolResult(
      {
        ok: false,
        correlation_id: correlationId,
        error: {
          code: "gateway_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      true,
    );
  }
}

async function readResourceEnvelope(
  correlationId: string,
  scopes: string[],
  fn: () => Promise<ApiEnvelope>,
): Promise<ApiEnvelope> {
  if (!hasScope(scopes, "documents:read")) {
    return {
      ok: false,
      correlation_id: correlationId,
      error: {
        code: "insufficient_scope",
        message: "Required scope 'documents:read' for data-room resources.",
      },
    };
  }
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      correlation_id: correlationId,
      error: {
        code: "gateway_request_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function envelopeToToolResult(envelope: ApiEnvelope, isError = false): CallToolResult {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    structuredContent: envelope,
  };
}

function resourceFromEnvelope(uri: string, envelope: ApiEnvelope) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(envelope, null, 2),
      },
    ],
  };
}

function oneValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
