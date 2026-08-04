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

import { loadGatewayConfig } from "./config.js";
import { createDataRoomMcpServer } from "./mcpServer.js";
import { authInfoFromAuthorization } from "./scopes.js";

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

const config = loadGatewayConfig();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const handler = createMcpHandler(
  ctx =>
    createDataRoomMcpServer({
      ragCoreBaseUrl: config.ragCoreBaseUrl,
      correlationId: ctx.requestInfo?.headers.get("x-correlation-id") ?? randomUUID(),
      scopes: ctx.authInfo?.scopes ?? config.defaultScopes,
    }),
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

  req.auth = authInfoFromAuthorization(req.headers.authorization, config.defaultScopes);
  void nodeHandler(req as NodeIncomingMessageLike, res as NodeServerResponseLike);
});

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
