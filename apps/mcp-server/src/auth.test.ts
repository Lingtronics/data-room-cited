import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { filterEnvelopeForAccess } from "./accessControl.js";
import { authenticateRequest } from "./auth.js";
import { loadGatewayConfig } from "./config.js";
import type { ApiEnvelope } from "./schemas.js";

describe("gateway authentication and document filters", () => {
  it("validates JWT auth context and derives workspace identity from claims", async () => {
    const config = loadGatewayConfig({
      MCP_AUTH_REQUIRED: "true",
      MCP_ALLOW_DEV_TOKENS: "false",
      MCP_AUTH_AUDIENCE: "http://mcp.test/mcp",
      MCP_AUTH_ISSUER: "issuer.test",
      MCP_DEV_JWT_SECRET: "test-secret",
    });
    const token = await mintToken({
      aud: "http://mcp.test/mcp",
      iss: "issuer.test",
      workspace_id: "deal-alpha",
      scope: "documents:read citations:verify",
      document_ids: ["allowed.pdf"],
    });

    const access = await authenticateRequest(`Bearer ${token}`, config);

    expect(access.workspaceId).toBe("deal-alpha");
    expect(access.scopes).toEqual(["documents:read", "citations:verify"]);
    expect(access.allowedDocumentIds).toEqual(["allowed.pdf"]);
  });

  it("rejects JWTs that do not carry tenant or workspace identity", async () => {
    const config = loadGatewayConfig({
      MCP_AUTH_REQUIRED: "true",
      MCP_ALLOW_DEV_TOKENS: "false",
      MCP_AUTH_AUDIENCE: "http://mcp.test/mcp",
      MCP_DEV_JWT_SECRET: "test-secret",
    });
    const token = await mintToken({
      aud: "http://mcp.test/mcp",
      scope: "documents:read",
    });

    await expect(authenticateRequest(`Bearer ${token}`, config)).rejects.toThrow(
      "missing workspace_id",
    );
  });

  it("filters search results by document access before content reaches callers", () => {
    const envelope: ApiEnvelope = {
      ok: true,
      correlation_id: "test",
      data: {
        results: [
          { doc: "allowed.pdf", chunk_id: "allowed-1", text: "allowed text" },
          { doc: "blocked.pdf", chunk_id: "blocked-1", text: "blocked text" },
        ],
      },
    };

    const filtered = filterEnvelopeForAccess(envelope, {
      token: "test",
      authMode: "jwt",
      clientId: "client",
      userId: "user",
      workspaceId: "deal-alpha",
      role: "reader",
      scopes: ["documents:read"],
      allowedDocumentIds: ["allowed.pdf"],
      approvalGrants: [],
    });

    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      const data = filtered.data as { results: Array<{ doc: string }> };
      expect(data.results).toEqual([{ doc: "allowed.pdf", chunk_id: "allowed-1", text: "allowed text" }]);
    }
  });

  it("blocks single catalogue assets outside the document allowlist", () => {
    const envelope: ApiEnvelope = {
      ok: true,
      correlation_id: "test",
      data: {
        found: true,
        asset: {
          title: "blocked.pdf / blocked-1",
          metadata: { doc: "blocked.pdf" },
        },
      },
    };

    const filtered = filterEnvelopeForAccess(envelope, {
      token: "test",
      authMode: "jwt",
      clientId: "client",
      userId: "user",
      workspaceId: "deal-alpha",
      role: "reader",
      scopes: ["documents:read"],
      allowedDocumentIds: ["allowed.pdf"],
      approvalGrants: [],
    });

    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.data).toEqual({
        found: false,
        error: "Document access denied for this asset.",
      });
    }
  });
});

async function mintToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode("test-secret"));
}
