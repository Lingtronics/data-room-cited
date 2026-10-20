import { VoicePolicy } from "@data-room-cited/mcp-server/voice-policy";
import { VoiceError } from "./errors.js";

export type VoiceConfig = { enabled: false } | {
  enabled: true;
  host: "127.0.0.1";
  port: number;
  origins: readonly string[];
  policy: VoicePolicy;
  mcpUrl: string;
  serviceToken: string;
  apiKey: string;
  agentId: string;
  requestsPerMinute: number;
  maxSessions: number;
  upstreamTimeoutMs: number;
};
export type EnabledConfig = Extract<VoiceConfig, { enabled: true }>;

export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  if (env.VOICE_FEATURE_ENABLED === undefined || env.VOICE_FEATURE_ENABLED === "false") return { enabled: false };
  try {
    if (env.VOICE_FEATURE_ENABLED !== "true" || env.VOICE_READ_ONLY_DEMO !== "true" ||
        (env.VOICE_API_HOST ?? "127.0.0.1") !== "127.0.0.1") throw new Error();
    const origins = (env.VOICE_ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map(s => s.trim());
    for (const origin of origins) {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          url.origin !== origin || url.username || url.password) throw new Error();
    }
    const mcp = new URL(env.VOICE_MCP_BASE_URL ?? "http://127.0.0.1:8787/mcp");
    if (mcp.protocol !== "http:" || mcp.hostname !== "127.0.0.1" || mcp.pathname !== "/mcp" ||
        mcp.username || mcp.password || mcp.search || mcp.hash) throw new Error();
    const serviceToken = env.VOICE_MCP_SERVICE_TOKEN ?? "";
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(serviceToken) || serviceToken.length > 8192) throw new Error();
    const apiKey = env.ELEVENLABS_API_KEY ?? "";
    const agentId = env.ELEVENLABS_AGENT_ID ?? "";
    if ((apiKey && (!/^[\x21-\x7e]{1,512}$/.test(apiKey))) ||
        (agentId && !/^agent_[A-Za-z0-9_-]{1,120}$/.test(agentId))) throw new Error();
    const policy = new VoicePolicy(env.VOICE_FIXTURE_DATA_DIR ?? "", env.VOICE_FIXTURE_INDEX_DIR ?? "");
    return {
      enabled: true, host: "127.0.0.1", port: integer(env.VOICE_API_PORT, 8790, 1, 65535),
      origins, policy, mcpUrl: mcp.href, serviceToken, apiKey, agentId,
      requestsPerMinute: integer(env.VOICE_REQUESTS_PER_MINUTE, 30, 1, 120),
      maxSessions: integer(env.VOICE_MAX_SESSIONS, 10, 1, 100),
      upstreamTimeoutMs: integer(env.VOICE_UPSTREAM_TIMEOUT_MS, 8000, 100, 15000),
    };
  } catch { throw new VoiceError("config_invalid"); }
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error();
  return Number(value);
}
