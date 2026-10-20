import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { VOICE_TOOLS } from "@data-room-cited/mcp-server/voice-policy";
import { decodeJwt } from "jose";
import type { EnabledConfig } from "./config.js";
import { VoiceError } from "./errors.js";
import { limitedText, type Fetch } from "./httpClient.js";
import { VerificationEnvelope, type Evidence, type EvidenceResult } from "./schemas.js";

export interface EvidenceGateway {
  check(): Promise<void>;
  verify(items: Evidence[]): Promise<EvidenceResult[]>;
}

export class McpEvidence implements EvidenceGateway {
  constructor(private readonly config: EnabledConfig, private readonly fetcher: Fetch = globalThis.fetch) {}

  async check(): Promise<void> { await this.withClient(async () => undefined); }

  async verify(items: Evidence[]): Promise<EvidenceResult[]> {
    const documents = this.restrictedClaims();
    for (const item of items) {
      const chunk = this.config.policy.chunks.get(item.chunk_id);
      if (!chunk || !documents.includes(chunk.doc)) throw new VoiceError("evidence_not_allowed");
    }
    return this.withClient(async (client, signal) => {
      const output: EvidenceResult[] = [];
      for (const item of items) {
        // This adapter has no arbitrary tool-name/resource interface.
        const result = await client.callTool({ name: "verify_citation", arguments: item }, { signal });
        output.push(this.verifiedItem(item, result));
      }
      return output;
    });
  }

  private verifiedItem(item: Evidence, result: { isError?: boolean | undefined; structuredContent?: unknown }): EvidenceResult {
    if (result.isError) throw new VoiceError("verification_failed");
    const envelope = VerificationEnvelope.safeParse(result.structuredContent);
    if (!envelope.success) throw new VoiceError("verification_failed");
    const data = envelope.data.data;
    if (data.chunk_id !== item.chunk_id || data.quote !== item.quote) throw new VoiceError("verification_failed");
    if (!data.verified) return { chunk_id: item.chunk_id, verified: false };
    const chunk = this.config.policy.chunks.get(item.chunk_id)!;
    if (data.document !== chunk.doc || data.section_title !== chunk.section_title ||
        !normalize(chunk.text).includes(normalize(item.quote))) throw new VoiceError("verification_failed");
    return { chunk_id: item.chunk_id, verified: true, quote: item.quote,
      document: data.document, page_label: data.page_label, section_title: data.section_title };
  }

  private async withClient<T>(run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.restrictedClaims();
    this.assertFixture();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    const client = new Client({ name: "data-room-voice-evidence", version: "1.0.0" });
    client.onerror = () => { /* Caller receives only stable errors, never SDK diagnostics. */ };
    const healthUrl = new URL("/health", this.config.mcpUrl).href;
    const boundedFetch: Fetch = async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (![this.config.mcpUrl, healthUrl].includes(target)) throw new VoiceError("mcp_unsafe");
      const response = await this.fetcher(input, { ...init, redirect: "error",
        signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new VoiceError("mcp_unavailable"); }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        return new Response(null, { status: response.status });
      }
      const text = await limitedText(response);
      return new Response(text, { status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
      fetch: boundedFetch, requestInit: { headers: { authorization: `Bearer ${this.config.serviceToken}` } },
      onInsufficientScope: "throw", maxStepUpRetries: 0,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    });
    try {
      const health = await (await boundedFetch(healthUrl)).json() as Record<string, unknown>;
      if (health.ok !== true || health.voice_fixture !== this.config.policy.fingerprint ||
          health.workspace_id !== this.config.policy.workspaceId || health.read_only !== true) throw new VoiceError("mcp_unsafe");
      // The gateway verifies the JWT signature, issuer, audience and expiry.
      // Decoding above only narrows what we send; it never authenticates a caller.
      await client.connect(transport, { signal: controller.signal });
      const capabilities = client.getServerCapabilities();
      if (capabilities?.resources || capabilities?.prompts) throw new VoiceError("mcp_unsafe");
      const listing = await client.listTools(undefined, { signal: controller.signal });
      if (listing.nextCursor || listing.tools.length !== VOICE_TOOLS.length ||
          VOICE_TOOLS.some(name => !listing.tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint === true)) ||
          listing.tools.some(tool => tool.annotations?.destructiveHint === true)) throw new VoiceError("mcp_unsafe");
      const result = await run(client, controller.signal);
      this.assertFixture();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceError("mcp_timeout");
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("mcp_unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  private assertFixture(): void {
    try { this.config.policy.assertFixture(); } catch { throw new VoiceError("fixture_unavailable"); }
  }

  private restrictedClaims(): string[] {
    try {
      const claims = decodeJwt(this.config.serviceToken);
      const scopes = typeof claims.scope === "string" ? claims.scope.split(/[ ,]+/).filter(Boolean) : [];
      if (typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.iss !== "string" || !claims.iss.trim() ||
          claims.aud !== this.config.mcpUrl || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 ||
          claims.workspace_id !== this.config.policy.workspaceId || claims.role !== "reader" ||
          !scopes.includes("citations:verify") || scopes.some(scope => !["documents:read", "citations:verify"].includes(scope)) ||
          claims.approvals !== undefined || (claims.approval_grants !== undefined &&
            (!Array.isArray(claims.approval_grants) || claims.approval_grants.length > 0)) ||
          !Array.isArray(claims.document_ids) || !claims.document_ids.length ||
          claims.document_ids.some(doc => typeof doc !== "string" || !this.config.policy.documents.includes(doc))) throw new Error();
      return claims.document_ids as string[];
    } catch { throw new VoiceError("mcp_unavailable"); }
  }
}
function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }
