import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
} from "@modelcontextprotocol/node";

import {
  accessContextFromAuthInfo,
  authenticateRequest,
  authInfoFromAccessContext,
  AuthError,
} from "./auth.js";
import { loadGatewayConfig } from "./config.js";
import { createDataRoomMcpServer } from "./mcpServer.js";
import { setupTelemetry } from "./otel.js";
import { RagCoreClient } from "./ragCoreClient.js";
import { readVoiceBody, VoiceIngressError } from "./voiceIngress.js";

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

const config = loadGatewayConfig();
if (config.voicePolicy) {
  await config.voicePolicy.assertUpstream(new RagCoreClient(config.ragCoreBaseUrl, randomUUID(), undefined, true));
}
setupTelemetry("data-room-cited.mcp-server");
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const handler = createMcpHandler(
  ctx => {
    const accessContext = accessContextFromAuthInfo(ctx.authInfo);
    const options = {
      ragCoreBaseUrl: config.ragCoreBaseUrl,
      correlationId: config.voicePolicy ? randomUUID() : ctx.requestInfo?.headers.get("x-correlation-id") ?? randomUUID(),
      approvalRequired: config.approvalRequired,
      ...(config.voicePolicy ? { voicePolicy: config.voicePolicy } : {}),
    };
    return createDataRoomMcpServer(
      accessContext === undefined ? options : { ...options, accessContext },
    );
  },
  {
    responseMode: "json",
    onerror: error => {
      console.error(JSON.stringify({ level: "error", message: config.voicePolicy ? "voice_protocol_failed" : error.message }));
    },
  },
);

const nodeHandler = toNodeHandler({ fetch: async (request, context) => {
  const response = await handler.fetch(request, context);
  // The SDK's SSE adapter sets no-cache itself; retain no-store for evidence.
  if (config.voicePolicy) response.headers.set("cache-control", "no-store, no-transform");
  return response;
} }, {
  onerror: error => {
    console.error(JSON.stringify({ level: "error", message: config.voicePolicy ? "voice_protocol_failed" : error.message }));
  },
});

const server = http.createServer((req: AuthenticatedIncomingMessage, res: ServerResponse) => {
  void handleRequest(req, res);
});

async function handleRequest(req: AuthenticatedIncomingMessage, res: ServerResponse): Promise<void> {
  let external = false;
  if (config.voiceIngress) {
    try {
      external = config.voiceIngress.classify(req) === "external";
      if (external) res.once("close", config.voiceIngress.reserve());
    } catch (error) {
      const status = error instanceof VoiceIngressError ? error.status : 403;
      writeJson(res, status, { ok: false, error: { code: error instanceof VoiceIngressError ? error.code : "voice_transport_denied", message: "Voice transport request denied." } });
      return;
    }
    if (!external && (!validateHost(req, res) || !validateOrigin(req, res))) return;
    res.setHeader("cache-control", "no-store");
    // Bound stalled uploads, authentication and response streams, including GET.
    const remaining = external ? config.voiceIngress.external!.expiresAt - Date.now() : 15_000;
    const deadline = setTimeout(() => { res.destroy(); req.destroy(); }, Math.max(1, Math.min(15_000, remaining)));
    res.once("close", () => clearTimeout(deadline));
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    if (config.voicePolicy) {
      try {
        config.voicePolicy.assertFixture();
        await config.voicePolicy.assertUpstream(new RagCoreClient(config.ragCoreBaseUrl, randomUUID(), undefined, true));
      } catch {
        writeJson(res, 503, { ok: false, error: { code: "voice_fixture_unavailable", message: "Voice fixture unavailable." } });
        return;
      }
    }
    writeJson(res, 200, {
      ok: true,
      service: "data-room-cited-mcp-gateway",
      rag_core_base_url: config.ragCoreBaseUrl,
      ...(config.voicePolicy ? {
        voice_fixture: config.voicePolicy.fingerprint,
        workspace_id: config.voicePolicy.workspaceId,
        read_only: true,
      } : {}),
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    writeJson(res, 404, {
      ok: false,
      error: {
        code: "not_found",
        message: "Use /mcp for Streamable HTTP MCP traffic.",
      },
    });
    return;
  }

  if (!config.voicePolicy && (!validateHost(req, res) || !validateOrigin(req, res))) {
    return;
  }

  try {
    const accessContext = await authenticateRequest(req.headers.authorization, config);
    req.auth = authInfoFromAccessContext(accessContext);
  } catch (error) {
    const statusCode = error instanceof AuthError ? error.statusCode : 401;
    writeJson(res, statusCode, {
      ok: false,
      error: {
        code: error instanceof AuthError ? error.code : "unauthorized",
        message: config.voicePolicy ? "Voice authentication denied." : error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  let parsedBody: unknown;
  if (config.voicePolicy && req.method === "POST") {
    try { parsedBody = await readVoiceBody(req); }
    catch (error) {
      if (!res.destroyed) writeJson(res, error instanceof VoiceIngressError ? error.status : 400,
        { ok: false, error: { code: error instanceof VoiceIngressError ? error.code : "voice_body_invalid", message: "Voice request body rejected." } });
      return;
    }
  }
  if (external && Date.now() >= config.voiceIngress!.external!.expiresAt) {
    writeJson(res, 403, { ok: false, error: { code: "voice_transport_denied", message: "Voice transport request denied." } });
    return;
  }
  if (!res.destroyed) void nodeHandler(req as NodeIncomingMessageLike, res as NodeServerResponseLike, parsedBody);
}

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Data Room Cited TypeScript MCP gateway listening",
      port: config.port,
      rag_core_base_url: config.ragCoreBaseUrl,
      endpoint: `http://127.0.0.1:${config.port}/mcp`,
    }),
  );
});

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json",
    ...(config.voicePolicy && statusCode >= 400 ? { connection: "close", "cache-control": "no-store" } : {}) });
  res.end(JSON.stringify(body));
}
