export type GatewayConfig = {
  port: number;
  ragCoreBaseUrl: string;
  defaultScopes: string[];
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
  return {
    port: integerFromEnv(env.MCP_GATEWAY_PORT, 8787),
    ragCoreBaseUrl: env.RAG_CORE_BASE_URL ?? "http://127.0.0.1:8765",
    defaultScopes: scopesFromEnv(env.MCP_DEFAULT_SCOPES ?? "documents:read,citations:verify"),
  };
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
