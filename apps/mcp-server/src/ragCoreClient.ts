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
  VerifyCitationInputSchema,
} from "./schemas.js";

type SearchDataRoomInput = Infer<typeof SearchDataRoomInputSchema>;
type VerifyCitationInput = Infer<typeof VerifyCitationInputSchema>;
type FindSupportingEvidenceInput = Infer<typeof FindSupportingEvidenceInputSchema>;
type GetAssetLineageInput = Infer<typeof GetAssetLineageInputSchema>;
type RebuildIndexInput = Infer<typeof RebuildIndexInputSchema>;
type ExportPowerPointOutlineInput = Infer<typeof ExportPowerPointOutlineInputSchema>;

export class RagCoreClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly correlationId: string = randomUUID(),
  ) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
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
    const url = new URL(path, this.baseUrl);
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-correlation-id": this.correlationId,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const json = (await response.json().catch(() => undefined)) as unknown;
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
  }
}
