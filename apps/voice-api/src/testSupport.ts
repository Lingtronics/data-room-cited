import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import { loadVoiceConfig, type EnabledConfig } from "./config.js";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const fixtureData = resolve(repoRoot, "fixtures/voice/data");
export const fixtureIndex = resolve(repoRoot, "fixtures/voice/index");
export const agentId = "agent_synthetic_test";
export const apiKey = "mock-api-key-sentinel";
export const signedUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&conversation_signature=private-signature-sentinel`;
export const item = { chunk_id: "voice-contracts-2025-1", quote: "SYNTHETIC DEMONSTRATION ONLY." };

export function configEnv(): NodeJS.ProcessEnv {
  return { VOICE_FEATURE_ENABLED: "true", VOICE_READ_ONLY_DEMO: "true",
    VOICE_FIXTURE_DATA_DIR: fixtureData, VOICE_FIXTURE_INDEX_DIR: fixtureIndex,
    VOICE_MCP_SERVICE_TOKEN: "test.jwt.placeholder", ELEVENLABS_AGENT_ID: agentId, ELEVENLABS_API_KEY: apiKey };
}
export async function testConfig(overrides: Partial<EnabledConfig> = {}): Promise<EnabledConfig> {
  const config = loadVoiceConfig(configEnv()) as EnabledConfig;
  const serviceToken = await tokenFor(config);
  return { ...config, serviceToken, ...overrides };
}
export async function tokenFor(config: EnabledConfig, claims: Record<string, unknown> = {}, secret: Uint8Array = randomBytes(32)): Promise<string> {
  return new SignJWT({ sub: "voice-test-service", iss: "voice-tests", aud: config.mcpUrl,
    exp: Math.floor(Date.now() / 1000) + 300, workspace_id: config.policy.workspaceId,
    scope: "documents:read citations:verify", role: "reader", document_ids: [...config.policy.documents], ...claims,
  }).setProtectedHeader({ alg: "HS256" }).sign(secret);
}
export function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
