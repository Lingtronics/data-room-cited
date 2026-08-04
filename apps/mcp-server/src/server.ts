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

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

const config = loadGatewayConfig();
setupTelemetry("data-room-cited.mcp-server");
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const handler = createMcpHandler(
  ctx => {
    const accessContext = accessContextFromAuthInfo(ctx.authInfo);
    const options = {
      ragCoreBaseUrl: config.ragCoreBaseUrl,
      correlationId: ctx.requestInfo?.headers.get("x-correlation-id") ?? randomUUID(),
      approvalRequired: config.approvalRequired,
    };
    return createDataRoomMcpServer(
      accessContext === undefined ? options : { ...options, accessContext },
    );
  },
  {
    responseMode: "json",
    onerror: error => {
      console.error(JSON.stringify({ level: "error", message: error.message }));
    },
  },
);

const nodeHandler = toNodeHandler(handler, {
  onerror: error => {
    console.error(JSON.stringify({ level: "error", message: error.message }));
  },
});

const server = http.createServer((req: AuthenticatedIncomingMessage, res: ServerResponse) => {
  void handleRequest(req, res);
});

async function handleRequest(req: AuthenticatedIncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    writeJson(res, 200, {
      ok: true,
      service: "data-room-cited-mcp-gateway",
      rag_core_base_url: config.ragCoreBaseUrl,
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

  if (!validateHost(req, res) || !validateOrigin(req, res)) {
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
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  void nodeHandler(req as NodeIncomingMessageLike, res as NodeServerResponseLike);
}

server.listen(config.port, () => {
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
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
