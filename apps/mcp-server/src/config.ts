import { assertLoopbackUrl, VoicePolicy, VOICE_SCOPES } from "./voicePolicy.js";
import { externalVoiceIngress, VoiceIngress } from "./voiceIngress.js";

export type GatewayConfig = {
  port: number;
  ragCoreBaseUrl: string;
  defaultScopes: string[];
  authRequired: boolean;
  allowDevTokens: boolean;
  authIssuer?: string;
  authAudience: string;
  jwksUrl?: string;
  devJwtSecret: string;
  defaultWorkspaceId: string;
  approvalRequired: boolean;
  host?: string;
  voicePolicy?: VoicePolicy;
  voiceIngress?: VoiceIngress;
};

export const ALL_SCOPES = [
  "documents:read",
  "citations:verify",
  "index:write",
  "exports:write",
  "admin:connectors",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const externalIngress = externalVoiceIngress(env);
  const port = integerFromEnv(env.MCP_GATEWAY_PORT, 8787);
  const config: GatewayConfig = {
    port,
    ragCoreBaseUrl: env.RAG_CORE_BASE_URL ?? "http://127.0.0.1:8765",
    defaultScopes: scopesFromEnv(env.MCP_DEFAULT_SCOPES ?? "documents:read,citations:verify"),
    authRequired: booleanFromEnv(env.MCP_AUTH_REQUIRED, false),
    allowDevTokens: booleanFromEnv(env.MCP_ALLOW_DEV_TOKENS, true),
    authAudience: env.MCP_AUTH_AUDIENCE ?? `http://127.0.0.1:${port}/mcp`,
    devJwtSecret: env.MCP_DEV_JWT_SECRET ?? "local-dev-only-change-me",
    defaultWorkspaceId: env.MCP_DEFAULT_WORKSPACE_ID ?? "local",
    approvalRequired: booleanFromEnv(env.MCP_APPROVAL_REQUIRED, true),
  };
  const authIssuer = optionalString(env.MCP_AUTH_ISSUER);
  if (authIssuer) {
    config.authIssuer = authIssuer;
  }
  const jwksUrl = optionalString(env.MCP_JWKS_URL);
  if (jwksUrl) {
    config.jwksUrl = jwksUrl;
  }
  if (env.VOICE_FEATURE_ENABLED !== undefined && !["true", "false"].includes(env.VOICE_FEATURE_ENABLED)) {
    throw new Error("VOICE_FEATURE_ENABLED must be true or false.");
  }
  if (env.VOICE_FEATURE_ENABLED === "true") {
    if (env.VOICE_READ_ONLY_DEMO !== "true" || env.MCP_AUTH_REQUIRED !== "true" ||
        env.MCP_ALLOW_DEV_TOKENS !== "false" || !config.authIssuer || !env.MCP_AUTH_AUDIENCE?.trim()) {
      throw new Error("Voice mode requires read-only demo, explicit auth, issuer/audience and disabled dev tokens.");
    }
    if (env.MCP_GATEWAY_HOST && env.MCP_GATEWAY_HOST !== "127.0.0.1") {
      throw new Error("Voice MCP_GATEWAY_HOST must be 127.0.0.1.");
    }
    if ((!jwksUrl && (!env.MCP_DEV_JWT_SECRET || Buffer.byteLength(env.MCP_DEV_JWT_SECRET) < 32)) ||
        (jwksUrl && new URL(jwksUrl).protocol !== "https:")) {
      throw new Error("Voice mode requires a dedicated 32-byte-or-longer JWT secret or HTTPS JWKS.");
    }
    if (config.defaultScopes.some(scope => !VOICE_SCOPES.includes(scope as typeof VOICE_SCOPES[number]))) {
      throw new Error("Voice mode permits read scopes only.");
    }
    assertLoopbackUrl(config.ragCoreBaseUrl);
    config.host = "127.0.0.1";
    config.voicePolicy = new VoicePolicy(env.VOICE_FIXTURE_DATA_DIR ?? "", env.VOICE_FIXTURE_INDEX_DIR ?? "");
    config.voiceIngress = new VoiceIngress(externalIngress);
  }
  return config;
}

function integerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scopesFromEnv(value: string): string[] {
  return value
    .split(",")
    .map(scope => scope.trim())
    .filter(Boolean);
}

function booleanFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
