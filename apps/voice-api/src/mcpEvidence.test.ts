import { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpEvidence } from "./mcpEvidence.js";
import { item, response, testConfig, tokenFor } from "./testSupport.js";
import type { EnabledConfig } from "./config.js";

describe("read-only MCP evidence adapter", () => {
  let config: EnabledConfig;
  const tools = ["search_data_room", "verify_citation"].map(name => ({ name,
    inputSchema: { type: "object" as const }, annotations: { readOnlyHint: true } }));
  const call = vi.fn();
  const fetcher = vi.fn<typeof fetch>();
  const envelope = (data: Record<string, unknown> = {}) => ({ structuredContent: {
    ok: true, correlation_id: "test-correlation", data: { ...item, verified: true, reason: "verified",
      document: "synthetic_contracts_2025.txt", page_label: null, section_title: "Synthetic contracts, 2025", ...data },
  }, content: [] });

  beforeEach(async () => {
    config = await testConfig();
    vi.spyOn(Client.prototype, "connect").mockResolvedValue();
    vi.spyOn(Client.prototype, "close").mockResolvedValue();
    vi.spyOn(Client.prototype, "getServerCapabilities").mockReturnValue({ tools: {} });
    vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools });
    vi.spyOn(Client.prototype, "callTool").mockImplementation(call);
    call.mockReset().mockResolvedValue(envelope());
    fetcher.mockReset().mockImplementation(async () => response({ ok: true, read_only: true,
      voice_fixture: config.policy.fingerprint, workspace_id: config.policy.workspaceId }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("authenticates, checks the profile, and calls only verify_citation", async () => {
    const result = await new McpEvidence(config, fetcher).verify([item]);
    expect(result).toEqual([{ ...item, verified: true, document: "synthetic_contracts_2025.txt",
      page_label: null, section_title: "Synthetic contracts, 2025" }]);
    expect(call).toHaveBeenCalledExactlyOnceWith({ name: "verify_citation", arguments: item }, { signal: expect.any(AbortSignal) });
    expect(Client.prototype.connect).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(Client.prototype.close).toHaveBeenCalledOnce();
  });
  it("returns no quote or metadata for an unsupported citation", async () => {
    call.mockResolvedValue({ structuredContent: { ok: true, correlation_id: "test", data: {
      ...item, verified: false, reason: "quote_not_found_in_source_text" } }, content: [] });
    expect(await new McpEvidence(config, fetcher).verify([item])).toEqual([{ chunk_id: item.chunk_id, verified: false }]);
  });
  it.each([
    { chunk_id: "wrong-id" }, { quote: "a fabricated quote" }, { document: "private.txt" },
    { page_label: 99 }, { section_title: "invented" }, { reason: "almost_verified" },
    { verified: "true" }, { url: "https://evil.test" },
  ])("rejects changed upstream verification data %j", async data => {
    call.mockResolvedValue(envelope(data));
    await expect(new McpEvidence(config, fetcher).verify([item])).rejects.toMatchObject({ code: "verification_failed" });
  });
  it.each([
    { content: [] }, { isError: true, content: [] },
    { structuredContent: { ok: false, error: { code: "forbidden" } }, content: [] },
    { structuredContent: { ...envelope().structuredContent, secret: "SECRET" }, content: [] },
  ])("fails closed for malformed/error envelopes", async value => {
    call.mockResolvedValue(value);
    await expect(new McpEvidence(config, fetcher).verify([item])).rejects.toMatchObject({ code: "verification_failed" });
  });
  it("does not trust an upstream true for text absent from the pinned source", async () => {
    const forged = { ...item, quote: "<script>invented revenue</script>" };
    call.mockResolvedValue(envelope(forged));
    await expect(new McpEvidence(config, fetcher).verify([forged])).rejects.toMatchObject({ code: "verification_failed" });
  });
  it.each([{ chunk_id: "unknown" }, { chunk_id: "voice-notes-2024-1" }])("rejects unknown/out-of-claim chunks before network", async override => {
    config.serviceToken = await tokenFor(config, { document_ids: ["synthetic_contracts_2025.txt"] });
    await expect(new McpEvidence(config, fetcher).verify([{ ...item, ...override }])).rejects.toMatchObject({ code: "evidence_not_allowed" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it.each([
    { exp: 1 }, { exp: undefined }, { aud: "wrong" }, { role: "admin" }, { workspace_id: "private" },
    { document_ids: [] }, { document_ids: ["private.txt"] }, { scope: "documents:read" },
    { scope: "citations:verify index:write" }, { approvals: [] }, { approval_grants: ["*"] },
  ])("rejects unsafe token claims before network %j", async claims => {
    config.serviceToken = await tokenFor(config, claims);
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "mcp_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ resources: {} }, { prompts: {} }])("rejects unapproved capabilities %j", async capabilities => {
    vi.mocked(Client.prototype.getServerCapabilities).mockReturnValue(capabilities);
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "mcp_unsafe" });
  });
  it.each([
    { tools: [] }, { tools: [...tools, { name: "rebuild_index", inputSchema: { type: "object" as const } }] },
    { tools, nextCursor: "more" }, { tools: tools.map(tool => ({ ...tool, annotations: { readOnlyHint: false } })) },
    { tools: tools.map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: true } })) },
  ])("rejects unsafe or incomplete tool lists", async listing => {
    vi.mocked(Client.prototype.listTools).mockResolvedValue(listing);
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "mcp_unsafe" });
  });
  it.each([{ ok: true }, { ok: true, read_only: false }, null])("rejects a wrong/malformed gateway profile", async health => {
    fetcher.mockResolvedValue(response(health));
    await expect(new McpEvidence(config, fetcher).check()).rejects.toBeDefined();
    expect(Client.prototype.connect).not.toHaveBeenCalled();
  });
  it("sanitizes fetch and SDK errors", async () => {
    fetcher.mockRejectedValue(new Error("SECRET service token and quote"));
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "mcp_unavailable" });
    try { await new McpEvidence(config, fetcher).check(); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });
  it("bounds the whole request and closes the client on timeout", async () => {
    config.upstreamTimeoutMs = 100;
    fetcher.mockImplementation((_input, init) => new Promise((_done, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private timeout diagnostics")), { once: true });
    }));
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "mcp_timeout" });
    expect(Client.prototype.close).toHaveBeenCalledOnce();
  });
  it("rejects fixture drift before fetching", async () => {
    vi.spyOn(config.policy, "assertFixture").mockImplementation(() => { throw new Error("private filename"); });
    await expect(new McpEvidence(config, fetcher).check()).rejects.toMatchObject({ code: "fixture_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
