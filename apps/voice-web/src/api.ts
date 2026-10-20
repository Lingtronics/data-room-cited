import * as z from "zod/v4";
import { EvidenceInput, EvidenceResponse, type Evidence, type EvidenceResult } from "@data-room-cited/voice-api/contracts";
import { isLocalApiOrigin } from "./config.js";
import { UiError } from "./errors.js";

export type Session = { signed_url: string; expires_at: string };
export interface Broker { session(signal: AbortSignal): Promise<Session>; verify(items: Evidence[], signal: AbortSignal): Promise<EvidenceResult[]> }
const SessionSchema = z.strictObject({ signed_url: z.string().max(8192), expires_at: z.iso.datetime() });
export function validSession(value: unknown, now = Date.now()): Session {
  const parsed = SessionSchema.safeParse(value);
  if (!parsed.success) throw new UiError("session_failed");
  try {
    const url = new URL(parsed.data.signed_url);
    const expires = Date.parse(parsed.data.expires_at);
    if (url.protocol !== "wss:" || url.host !== "api.elevenlabs.io" || url.pathname !== "/v1/convai/conversation" ||
        url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(parsed.data.signed_url) ||
        url.searchParams.getAll("agent_id").length !== 1 || !url.searchParams.get("agent_id")?.startsWith("agent_") ||
        url.searchParams.getAll("conversation_signature").length !== 1 || !url.searchParams.get("conversation_signature") ||
        [...url.searchParams.keys()].some(key => !["agent_id", "conversation_signature", "conversation_id"].includes(key)) ||
        expires <= now || expires > now + 15 * 60_000 + 30_000) throw new Error();
    return parsed.data;
  } catch { throw new UiError("session_failed"); }
}
export function verifiedResponse(value: unknown, requested: Evidence[]): EvidenceResult[] {
  const parsed = EvidenceResponse.safeParse(value);
  if (!parsed.success || parsed.data.items.length !== requested.length || parsed.data.items.some((item, index) =>
    item.chunk_id !== requested[index]?.chunk_id || (item.verified && item.quote !== requested[index]?.quote))) throw new UiError("verification_failed");
  return parsed.data.items;
}
export class LocalBroker implements Broker {
  constructor(private readonly origin: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    if (!isLocalApiOrigin(origin)) throw new UiError("local_only");
  }
  async session(signal: AbortSignal): Promise<Session> { return validSession(await this.post("session", {}, signal)); }
  async verify(items: Evidence[], signal: AbortSignal): Promise<EvidenceResult[]> {
    const parsed = EvidenceInput.safeParse({ items });
    if (!parsed.success) throw new UiError("invalid_evidence");
    return verifiedResponse(await this.post("evidence/verify", parsed.data, signal), parsed.data.items);
  }
  private async post(route: string, body: unknown, parent: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) controller.abort();
    const timer = setTimeout(abort, 20_000);
    try {
      const response = await this.fetcher(`${this.origin}/api/voice/${route}`, { method: "POST", mode: "cors",
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0; let text = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) throw new Error();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      const data = JSON.parse(text) as { error?: { code?: unknown } };
      if (!response.ok) {
        const code = data?.error?.code;
        if (code === "config_missing") throw new UiError("config_missing");
        if (code === "rate_limited" || code === "session_limit_reached") throw new UiError("rate_limited");
        if (["mcp_unavailable", "mcp_unsafe", "mcp_timeout", "fixture_unavailable"].includes(String(code))) throw new UiError("mcp_unavailable");
        throw new UiError(route === "session" ? "session_failed" : "verification_failed");
      }
      return data;
    } catch (error) {
      if (parent.aborted) throw new DOMException("Request cancelled", "AbortError");
      if (error instanceof UiError) throw error;
      throw new UiError(route === "session" ? "session_failed" : "verification_failed");
    } finally { clearTimeout(timer); parent.removeEventListener("abort", abort); }
  }
}
