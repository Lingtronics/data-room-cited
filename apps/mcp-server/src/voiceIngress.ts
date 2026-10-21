import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export type ExternalVoiceIngress = { origin: string; host: string; expiresAt: number; allowedOrigins: string[] };
export class VoiceIngressError extends Error {
  constructor(readonly status: number, readonly code: string) { super("Voice transport request denied."); }
}

// Configuration is inert: this module never opens a tunnel or a public listener.
export function externalVoiceIngress(env: NodeJS.ProcessEnv, now = Date.now()): ExternalVoiceIngress | undefined {
  const origin = env.VOICE_MCP_EXTERNAL_ORIGIN ?? "";
  const expiry = env.VOICE_MCP_EXTERNAL_EXPIRES_AT ?? "";
  const origins = env.VOICE_MCP_EXTERNAL_ALLOWED_ORIGINS ?? "";
  if (!origin && !expiry && !origins) return;
  if (env.VOICE_FEATURE_ENABLED !== "true" || !origin || !expiry) throw new Error("External voice ingress requires voice mode, an exact HTTPS origin and expiry.");
  const host = publicOrigin(origin).host;
  const expiresAt = Date.parse(expiry);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiry) ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 60_000) {
    throw new Error("External voice ingress expiry must be a future UTC timestamp within 30 minutes.");
  }
  const allowedOrigins = origins ? origins.split(",").map(value => { publicOrigin(value); return value; }) : [];
  if (allowedOrigins.length > 5 || new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error("External voice Origins must be distinct and bounded.");
  return { origin, host, expiresAt, allowedOrigins };
}

function publicOrigin(value: string): URL {
  const fail = () => { throw new Error("External voice ingress requires an exact public HTTPS origin without path, credentials or wildcard."); };
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || url.origin !== value || url.port || url.username || url.password ||
      isIP(url.hostname) || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) return fail();
  return url;
}

type RequestHead = Pick<IncomingMessage, "headers" | "rawHeaders" | "url" | "method"> & {
  socket: { remoteAddress?: string | undefined; localPort?: number | undefined };
};
export class VoiceIngress {
  private windowStart = 0;
  private requests = 0;
  private inFlight = 0;
  constructor(readonly external?: ExternalVoiceIngress, private readonly now = Date.now) {}

  classify(req: RequestHead): "local" | "external" {
    const deny = () => { throw new VoiceIngressError(403, "voice_transport_denied"); };
    if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) return deny();
    for (const name of ["host", "origin", "authorization", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-for"]) {
      if (req.rawHeaders.filter((_, index) => index % 2 === 0).filter(key => key.toLowerCase() === name).length > 1) return deny();
    }
    const forwarding = Object.keys(req.headers).filter(key => key === "forwarded" || key.startsWith("x-forwarded-"));
    const host = req.headers.host;
    if ([`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`].includes(host ?? "")) {
      if (forwarding.length) return deny();
      return "local";
    }
    const external = this.external;
    if (!external || this.now() >= external.expiresAt || host !== external.host || req.url !== "/mcp" ||
        !["POST", "GET", "DELETE"].includes(req.method ?? "") || req.headers["x-forwarded-proto"] !== "https" ||
        forwarding.some(key => !["x-forwarded-proto", "x-forwarded-host", "x-forwarded-for"].includes(key)) ||
        (req.headers["x-forwarded-host"] !== undefined && req.headers["x-forwarded-host"] !== external.host) ||
        (req.headers.origin !== undefined && (typeof req.headers.origin !== "string" || !external.allowedOrigins.includes(req.headers.origin)))) return deny();
    // Forwarded IPs are untrusted metadata, never authentication or rate-limit keys.
    if (req.headers["x-forwarded-for"] !== undefined &&
        (typeof req.headers["x-forwarded-for"] !== "string" || req.headers["x-forwarded-for"].length > 256 ||
          req.headers["x-forwarded-for"].split(",").some(value => !isIP(value.trim())))) return deny();
    return "external";
  }

  reserve(): () => void {
    const now = this.now();
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.requests = 0; }
    if (++this.requests > 120 || this.inFlight >= 4) throw new VoiceIngressError(429, "voice_transport_limited");
    this.inFlight++;
    let released = false;
    return () => { if (!released) { released = true; this.inFlight--; } };
  }
}

// Pass the parsed body to the SDK's supported adapter parameter so its unbounded
// raw-stream reader is never used for voice POSTs. No buffers enter diagnostics.
export async function readVoiceBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") ||
      req.headers["content-encoding"] !== undefined) throw new VoiceIngressError(415, "voice_body_invalid");
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65_536)) throw new VoiceIngressError(413, "voice_body_too_large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new VoiceIngressError(413, "voice_body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new VoiceIngressError(400, "voice_body_invalid"); }
}
