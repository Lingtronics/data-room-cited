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
