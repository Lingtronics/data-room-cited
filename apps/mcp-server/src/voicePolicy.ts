import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { AccessContext } from "./auth.js";
import type { RagCoreClient } from "./ragCoreClient.js";
import type { ApiEnvelope } from "./schemas.js";

export const VOICE_TOOLS = ["search_data_room", "verify_citation"] as const;
export const VOICE_SCOPES = ["documents:read", "citations:verify"] as const;
const repoRoot = resolve(import.meta.dirname, "../../..");
const bundle = join(repoRoot, "fixtures", "voice");
type Chunk = { chunk_id: string; doc: string; text: string; section_title: string };
type Manifest = {
  workspace_id: string;
  documents: string[];
  files: Record<"data" | "index", Record<string, { bytes: number; sha256: string }>>;
};

export class VoicePolicy {
  readonly fingerprint: string;
  readonly workspaceId: string;
  readonly documents: readonly string[];
  readonly chunks: ReadonlyMap<string, Chunk>;
  private readonly manifest: Manifest;

  constructor(readonly dataDir: string, readonly indexDir: string) {
    const raw = readFileSync(join(bundle, "manifest.json"));
    this.fingerprint = hash(raw);
    this.manifest = JSON.parse(raw.toString()) as Manifest;
    this.workspaceId = this.manifest.workspace_id;
    this.documents = this.manifest.documents;
    this.assertFixture();
    const chunks = JSON.parse(readFileSync(join(indexDir, "chunks.json"), "utf8")) as Chunk[];
    this.chunks = new Map(chunks.map(chunk => [chunk.chunk_id, Object.freeze(chunk)]));
  }

  assertFixture(): void {
    if (!isAbsolute(this.dataDir) || !isAbsolute(this.indexDir)) {
      throw new Error("Voice fixture paths must be absolute.");
    }
    const data = plainPath(this.dataDir);
    const index = plainPath(this.indexDir);
    if (data === index || data.startsWith(`${index}/`) || index.startsWith(`${data}/`) ||
        data === normalized(join(repoRoot, "data")) || index === normalized(join(repoRoot, "index"))) {
      throw new Error("Voice data/index must be separate from ordinary data/index and each other.");
    }
    for (const [kind, directory] of [["data", this.dataDir], ["index", this.indexDir]] as const) {
      const expected = this.manifest.files[kind];
      if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
        throw new Error("Voice fixture contains missing or unapproved files.");
      }
      for (const [name, entry] of Object.entries(expected)) {
        const path = join(directory, name);
        plainPath(path);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size !== entry.bytes || hash(readFileSync(path)) !== entry.sha256) {
          throw new Error("Voice fixture differs from approved synthetic data.");
        }
      }
    }
  }

  assertAccess(access: AccessContext): void {
    if (access.authMode !== "jwt" || access.workspaceId !== this.workspaceId ||
        access.role !== "reader" || !access.userId || access.userId === "unknown-user" ||
        !access.expiresAt || access.expiresAt <= Date.now() / 1000 ||
        !access.allowedDocumentIds.length ||
        access.allowedDocumentIds.some(doc => !this.documents.includes(doc)) ||
        access.scopes.some(scope => !VOICE_SCOPES.includes(scope as typeof VOICE_SCOPES[number])) ||
        access.approvalGrants.length) {
      throw new Error("Voice access requires an expiring read-only JWT for the synthetic workspace and exact documents.");
    }
  }

  async assertUpstream(client: RagCoreClient): Promise<void> {
    const health = await client.getHealth();
    const data = health.ok ? record(health.data) : {};
    if (data.voice_fixture !== this.fingerprint || data.workspace_id !== this.workspaceId || data.read_only !== true) {
      throw new Error("Voice gateway requires a matching read-only synthetic RAG core.");
    }
  }

  async read(
    tool: typeof VOICE_TOOLS[number], input: Record<string, unknown>,
    client: RagCoreClient, access: AccessContext, correlationId: string,
    invoke: () => Promise<ApiEnvelope>,
  ): Promise<ApiEnvelope> {
    try {
      this.assertAccess(access);
      this.assertFixture();
      if (tool === "verify_citation") {
        const chunk = this.chunks.get(String(input.chunk_id));
        if (!chunk || !access.allowedDocumentIds.includes(chunk.doc)) {
          return failure(correlationId, "forbidden_document");
        }
      }
      await this.assertUpstream(client);
      const envelope = await invoke();
      this.assertFixture();
      if (!envelope.ok) return failure(correlationId, "voice_upstream_failed");
      const data = record(envelope.data);
      if (tool === "search_data_room") {
        if (data.mode !== "lexical" || data.query !== input.query ||
            !Array.isArray(data.results) || data.results.length > Number(input.top_k ?? 5)) {
          throw new Error("Invalid search envelope");
        }
        const results = data.results.map(item => {
          const result = record(item);
          const chunk = this.chunks.get(String(result.chunk_id));
          if (!chunk || result.doc !== chunk.doc || result.text !== chunk.text ||
              !access.allowedDocumentIds.includes(chunk.doc) ||
              typeof result.score !== "number" || !Number.isFinite(result.score)) {
            throw new Error("Unapproved search evidence");
          }
          // Reconstruct trusted metadata; never forward unknown upstream fields.
          return { chunk_id: chunk.chunk_id, doc: chunk.doc, text: chunk.text,
            section_title: chunk.section_title, page_label: null, score: result.score };
        });
        return { ok: true, correlation_id: correlationId, data: {
          query: input.query, top_k: input.top_k ?? 5, mode: "lexical", results,
        } };
      }
      const chunk = this.chunks.get(String(input.chunk_id))!;
      if (typeof data.verified !== "boolean" || data.chunk_id !== input.chunk_id || data.quote !== input.quote) {
        throw new Error("Invalid verification envelope");
      }
      if (data.verified && !normalize(chunk.text).includes(normalize(String(input.quote)))) {
        throw new Error("Untrusted verification result");
      }
      return { ok: true, correlation_id: correlationId, data: {
        chunk_id: chunk.chunk_id, quote: input.quote, verified: data.verified,
        reason: data.verified ? "verified" : "quote_not_found_in_source_text",
        ...(data.verified ? { document: chunk.doc, page_label: null, section_title: chunk.section_title } : {}),
      } };
    } catch {
      return failure(correlationId, "voice_request_failed");
    }
  }
}

export function assertLoopbackUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Voice RAG_CORE_BASE_URL must be an HTTP 127.0.0.1 origin without credentials/path/query.");
  }
}

function plainPath(path: string): string {
  let part = resolve(path);
  while (true) {
    if (lstatSync(part).isSymbolicLink()) throw new Error("Voice fixture links/junctions are forbidden.");
    if (dirname(part) === part) break;
    part = dirname(part);
  }
  return normalized(realpathSync(path));
}
function normalized(path: string): string {
  const value = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function hash(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }
function normalize(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid envelope");
  return value as Record<string, unknown>;
}
function failure(correlationId: string, code: string): ApiEnvelope {
  return { ok: false, correlation_id: correlationId, error: { code, message: "Voice evidence unavailable or access denied." } };
}
