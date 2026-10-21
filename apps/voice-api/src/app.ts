import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { VoiceConfig } from "./config.js";
import { ElevenLabsSessions, type Session } from "./elevenLabs.js";
import { safeError, VoiceError, type ErrorCode } from "./errors.js";
import { LocalLimits } from "./limits.js";
import { McpEvidence, type EvidenceGateway } from "./mcpEvidence.js";
import { EvidenceInput, SessionInput } from "./schemas.js";

type Route = "session" | "evidence" | "other";
export type AuditEvent = { correlation_id: string; route: Route; status: number; duration_ms: number;
  error_code?: ErrorCode; verified_count?: number; rejected_count?: number };
export type Dependencies = { sessions: { issue(): Promise<Session> }; evidence: EvidenceGateway;
  audit?: (event: AuditEvent) => void };

export function createVoiceApi(config: VoiceConfig, dependencies?: Dependencies) {
  const evidence = dependencies?.evidence ?? (config.enabled ? new McpEvidence(config) : undefined);
  const sessions = dependencies?.sessions ?? (config.enabled ? new ElevenLabsSessions(config) : undefined);
  const audit = dependencies?.audit ?? ((event: AuditEvent) => console.log(JSON.stringify(event)));
  const limits = config.enabled ? new LocalLimits(config.requestsPerMinute, config.maxSessions) : undefined;

  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 40;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const event: AuditEvent = { correlation_id: randomUUID(), route: "other", status: 500, duration_ms: 0 };
    let origin: string | undefined;
    try {
      if (!config.enabled) throw new VoiceError("feature_disabled");
      assertLocal(req);
      origin = typeof req.headers.origin === "string" && config.origins.includes(req.headers.origin) ? req.headers.origin : undefined;
      if (!origin) throw new VoiceError("origin_denied");
      if (req.url === "/api/voice/session") event.route = "session";
      else if (req.url === "/api/voice/evidence/verify") event.route = "evidence";
      else throw new VoiceError("not_found");
      if (req.method === "OPTIONS") {
        if (req.headers["access-control-request-method"] !== "POST" ||
            (req.headers["access-control-request-headers"] ?? "").toString().split(",")
              .some(header => header.trim() && header.trim().toLowerCase() !== "content-type")) throw new VoiceError("origin_denied");
        event.status = 204;
        respond(res, 204, undefined, origin);
        return;
      }
      if (req.method !== "POST") throw new VoiceError("method_not_allowed");
      limits!.request();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new VoiceError("unsupported_media_type");
      const input = await readJson(req);
      let result: unknown;
      if (event.route === "session") {
        if (!SessionInput.safeParse(input).success) throw new VoiceError("invalid_request");
        if (!config.apiKey || !config.agentId) throw new VoiceError("config_missing");
        // Reserve before awaits: concurrent requests cannot overrun the cost cap.
        limits!.reserveSession();
        await evidence!.check();
        result = await sessions!.issue();
      } else {
        const parsed = EvidenceInput.safeParse(input);
        if (!parsed.success) throw new VoiceError("invalid_request");
        const items = await evidence!.verify(parsed.data.items);
        event.verified_count = items.filter(item => item.verified).length;
        event.rejected_count = items.length - event.verified_count;
        result = { items };
      }
      event.status = 200;
      respond(res, 200, result, origin);
    } catch (error) {
      const failure = safeError(error);
      event.status = failure.status;
      event.error_code = failure.code;
      respond(res, failure.status, { error: { code: failure.code, message: failure.message }, correlation_id: event.correlation_id }, origin);
    } finally {
      event.duration_ms = Math.round(performance.now() - started);
      try { audit(event); } catch { /* A telemetry sink must not change request handling. */ }
    }
  }

  return { server, async start(): Promise<void> {
    if (!config.enabled) return;
    await evidence!.check(); // Fail before listening if authentication/profile checks fail.
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.off("error", reject); done(); });
    });
  } };
}

export function assertLocal(req: Pick<IncomingMessage, "headers" | "socket">): void {
  if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") ||
      ![`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`].includes(req.headers.host ?? "") ||
      Object.keys(req.headers).some(header => header === "forwarded" || header.startsWith("x-forwarded-"))) {
    throw new VoiceError("local_only");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const length = req.headers["content-length"];
  if (length && Number(length) > 65_536) throw new VoiceError("body_too_large");
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of req) {
      const bytes = Buffer.from(part as Uint8Array);
      size += bytes.length;
      if (size > 65_536) throw new VoiceError("body_too_large");
      parts.push(bytes);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError("invalid_request");
  }
}

function respond(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Origin",
    ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type" } : {}),
    ...(status >= 400 ? { connection: "close" } : {}),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
