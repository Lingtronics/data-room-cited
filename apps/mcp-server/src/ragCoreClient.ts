import { randomUUID } from "node:crypto";

import type { infer as Infer } from "zod/v4";

import {
  ApiEnvelopeSchema,
  type ApiEnvelope,
  ExportPowerPointOutlineInputSchema,
  FindSupportingEvidenceInputSchema,
  GetAssetLineageInputSchema,
  RebuildIndexInputSchema,
  SearchDataRoomInputSchema,
  SyncDocumentSourceInputSchema,
  VerifyCitationInputSchema,
} from "./schemas.js";
import type { AccessContext } from "./auth.js";
import { injectTraceHeaders, withSpan } from "./telemetry.js";

type SearchDataRoomInput = Infer<typeof SearchDataRoomInputSchema>;
type VerifyCitationInput = Infer<typeof VerifyCitationInputSchema>;
type FindSupportingEvidenceInput = Infer<typeof FindSupportingEvidenceInputSchema>;
type GetAssetLineageInput = Infer<typeof GetAssetLineageInputSchema>;
type RebuildIndexInput = Infer<typeof RebuildIndexInputSchema>;
type SyncDocumentSourceInput = Infer<typeof SyncDocumentSourceInputSchema>;
type ExportPowerPointOutlineInput = Infer<typeof ExportPowerPointOutlineInputSchema>;

export class RagCoreClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly correlationId: string = randomUUID(),
    private readonly accessContext?: AccessContext,
    private readonly voiceMode = false,
  ) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  }

  getHealth(): Promise<ApiEnvelope> {
    return this.get("health");
  }

  searchDataRoom(input: SearchDataRoomInput): Promise<ApiEnvelope> {
    return this.post("retrieval/search", {
      query: input.query,
      top_k: input.top_k,
      semantic: input.semantic ?? true,
    });
  }

  getChunk(chunkId: string): Promise<ApiEnvelope> {
    return this.get(`chunks/${encodeURIComponent(chunkId)}`);
  }

  verifyCitation(input: VerifyCitationInput): Promise<ApiEnvelope> {
    return this.post("citations/verify", input);
  }

  getDocumentCoverage(): Promise<ApiEnvelope> {
    return this.get("documents/coverage");
  }

  getDocument(documentId: string): Promise<ApiEnvelope> {
    return this.get(`documents/${encodeURIComponent(documentId)}`);
  }

  getDataAsset(assetId: string): Promise<ApiEnvelope> {
    return this.get(`catalogue/assets/${encodeURIComponent(assetId)}`);
  }

  getAssetLineage(input: GetAssetLineageInput): Promise<ApiEnvelope> {
    const params = new URLSearchParams({ depth: String(input.depth ?? 2) });
    return this.get(`catalogue/assets/${encodeURIComponent(input.asset_id)}/lineage?${params}`);
  }

  findSupportingEvidence(input: FindSupportingEvidenceInput): Promise<ApiEnvelope> {
    const params = new URLSearchParams({
      query: input.query,
      limit: String(input.limit ?? 10),
    });
    return this.get(`graph/evidence?${params}`);
  }

  listDocumentSourceDocuments(): Promise<ApiEnvelope> {
    return this.get("connectors/documents");
  }

  syncDocumentSource(input: SyncDocumentSourceInput): Promise<ApiEnvelope> {
    return this.post("connectors/sync", {
      rebuild: input.rebuild ?? false,
      contextualize: input.contextualize ?? null,
    });
  }

  rebuildIndex(input: RebuildIndexInput): Promise<ApiEnvelope> {
    return this.post("index/rebuild", {
      contextualize: input.contextualize ?? null,
    });
  }

  exportPowerPointOutline(input: ExportPowerPointOutlineInput): Promise<ApiEnvelope> {
    return this.post("exports/outlines", input);
  }

  getLatestEvals(): Promise<ApiEnvelope> {
    return this.get("evals/latest");
  }

  private async get(path: string): Promise<ApiEnvelope> {
    return this.request("GET", path);
  }

  private async post(path: string, body: unknown): Promise<ApiEnvelope> {
    return this.request("POST", path, body);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiEnvelope> {
    return withSpan(
      "rag_core.request",
      {
        "http.request.method": method,
        "url.path": path.split("?")[0],
        "correlation_id": this.correlationId,
      },
      async () => {
        try {
          const url = new URL(path, this.baseUrl);
          const headers = injectTraceHeaders({
            accept: "application/json",
            "content-type": "application/json",
            "x-correlation-id": this.correlationId,
            ...this.accessHeaders(),
          });
          const init: RequestInit = {
            method,
            headers,
            ...(this.voiceMode ? { signal: AbortSignal.timeout(5_000), redirect: "error" as const } : {}),
          };
          if (body !== undefined) {
            init.body = JSON.stringify(body);
          }
          const response = await fetch(url, init);
          let json: unknown;
          if (this.voiceMode) {
            if (!response.ok || !response.body) throw new Error("Voice upstream unavailable.");
            const reader = response.body.getReader();
            const parts: Uint8Array[] = [];
            let length = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > 65_536) throw new Error("Voice upstream response too large.");
                parts.push(value);
              }
              json = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
            } finally { await reader.cancel(); }
          } else {
            json = (await response.json().catch(() => undefined)) as unknown;
          }
          const parsed = ApiEnvelopeSchema.safeParse(json);
          if (parsed.success) {
            return parsed.data;
          }
          return {
            ok: false,
            correlation_id: response.headers.get("x-correlation-id") ?? this.correlationId,
            error: {
              code: `HTTP_${response.status}`,
              message: response.ok
                ? "RAG core returned an unexpected response envelope."
                : `RAG core request failed with HTTP ${response.status}.`,
            },
          };
        } catch (error) {
          // Prevent JSON parser fragments/upstream failures from reaching spans.
          if (this.voiceMode) throw new Error("Voice upstream request failed.");
          throw error;
        }
      },
    );
  }

  private accessHeaders(): Record<string, string> {
    if (!this.accessContext) {
      return {};
    }
    return {
      "x-workspace-id": this.accessContext.workspaceId,
      "x-user-id": this.accessContext.userId,
      "x-user-role": this.accessContext.role,
      "x-auth-scopes": this.accessContext.scopes.join(","),
      "x-allowed-document-ids": this.accessContext.allowedDocumentIds.join(","),
    };
  }
}
