import * as z from "zod/v4";
import type { EnabledConfig } from "./config.js";
import { VoiceError } from "./errors.js";
import { limitedText, type Fetch } from "./httpClient.js";

const SIGNED_URL_VALIDITY_MS = 15 * 60 * 1000;
const ProviderResponse = z.strictObject({
  signed_url: z.string().min(1).max(8192), conversation_id: z.string().min(1).max(200).optional(),
});
export type Session = { signed_url: string; expires_at: string };

export class ElevenLabsSessions {
  constructor(private readonly config: EnabledConfig, private readonly fetcher: Fetch = globalThis.fetch,
    private readonly now: () => number = Date.now) {}

  async issue(): Promise<Session> {
    const { apiKey, agentId } = this.config;
    if (!apiKey || !agentId) throw new VoiceError("config_missing");
    const started = this.now();
    const signal = AbortSignal.timeout(this.config.upstreamTimeoutMs);
    const endpoint = new URL("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url");
    endpoint.searchParams.set("agent_id", agentId);
    // Documented single-use option; never retry issuance or cache its result.
    endpoint.searchParams.set("include_conversation_id", "true");
    try {
      const response = await this.fetcher(endpoint, { method: "GET", signal, redirect: "error",
        headers: { "xi-api-key": apiKey, accept: "application/json" }, cache: "no-store" });
      if (!response.ok) { await response.body?.cancel(); throw new VoiceError("session_upstream_failed"); }
      const parsed = ProviderResponse.safeParse(JSON.parse(await limitedText(response, 16_384)));
      if (!parsed.success) throw new VoiceError("session_invalid_response");
      const value = parsed.data.signed_url;
      const url = new URL(value);
      if (/[\x00-\x20\x7f]/.test(value) || url.protocol !== "wss:" || url.host !== "api.elevenlabs.io" ||
          url.pathname !== "/v1/convai/conversation" || url.username || url.password || url.hash ||
          url.searchParams.getAll("agent_id").length !== 1 || url.searchParams.get("agent_id") !== agentId ||
          url.searchParams.getAll("conversation_signature").length !== 1 || !url.searchParams.get("conversation_signature") ||
          [...url.searchParams.keys()].some(key => !["agent_id", "conversation_signature", "conversation_id"].includes(key)) ||
          value.includes(apiKey) || [...url.searchParams.values()].some(part => part.includes(apiKey))) throw new VoiceError("session_invalid_response");
      return { signed_url: value, expires_at: new Date(started + SIGNED_URL_VALIDITY_MS).toISOString() };
    } catch (error) {
      if (signal.aborted) throw new VoiceError("session_timeout");
      if (error instanceof VoiceError) throw error;
      // Never include upstream exception text, response fragments or request URLs.
      throw new VoiceError(error instanceof SyntaxError || error instanceof TypeError ? "session_invalid_response" : "session_upstream_failed");
    }
  }
}
