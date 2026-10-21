import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";

import { ALL_SCOPES, type GatewayConfig, type Scope } from "./config.js";

const READ_ONLY_SCOPES: Scope[] = ["documents:read", "citations:verify"];
const WRITE_SCOPES: Scope[] = ["documents:read", "citations:verify", "index:write", "exports:write"];

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type AccessContext = {
  token: string;
  authMode: "dev-token" | "jwt";
  clientId: string;
  userId: string;
  workspaceId: string;
  role: string;
  scopes: string[];
  allowedDocumentIds: string[];
  approvalGrants: string[];
  expiresAt?: number;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 401,
    readonly code = "unauthorized",
  ) {
    super(message);
  }
}

export async function authenticateRequest(
  authorizationHeader: string | string[] | undefined,
  config: GatewayConfig,
): Promise<AccessContext> {
  const token = bearerTokenFromHeader(authorizationHeader);
  if (!token) {
    if (config.authRequired) {
      throw new AuthError("Missing Authorization bearer token.");
    }
    return devAccessContext("read", config);
  }

  if (config.allowDevTokens && isDevToken(token)) {
    return devAccessContext(token, config);
  }

  return jwtAccessContext(token, config);
}

export function authInfoFromAccessContext(accessContext: AccessContext): AuthInfo {
  const authInfo: AuthInfo = {
    token: accessContext.token,
    clientId: accessContext.clientId,
    scopes: accessContext.scopes,
    extra: { accessContext },
  };
  if (accessContext.expiresAt !== undefined) {
    authInfo.expiresAt = accessContext.expiresAt;
  }
  return authInfo;
}

export function accessContextFromAuthInfo(authInfo: AuthInfo | undefined): AccessContext | undefined {
  const maybeContext = authInfo?.extra?.accessContext;
  if (isAccessContext(maybeContext)) {
    return maybeContext;
  }
  return undefined;
}

export function hasScope(scopes: readonly string[], requiredScope: Scope): boolean {
  return scopes.includes(requiredScope) || scopes.includes("admin:connectors");
}

export function hasApproval(accessContext: AccessContext, toolName: string): boolean {
  return (
    accessContext.approvalGrants.includes(toolName) ||
    accessContext.approvalGrants.includes("*")
  );
}

function bearerTokenFromHeader(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }
  return value.slice("Bearer ".length).trim() || undefined;
}

function isDevToken(token: string): boolean {
  return (
    ["read", "write", "write-approved", "admin"].includes(token) ||
    token.split(",").some(scope => ALL_SCOPES.includes(scope.trim() as Scope))
  );
}

function devAccessContext(token: string, config: GatewayConfig): AccessContext {
  const scopes = scopesForDevToken(token, config.defaultScopes);
  return {
    token,
    authMode: "dev-token",
    clientId: clientIdForDevToken(token),
    userId: clientIdForDevToken(token),
    workspaceId: config.defaultWorkspaceId,
    role: token === "admin" ? "admin" : token.startsWith("write") ? "writer" : "reader",
    scopes,
    allowedDocumentIds: [],
    approvalGrants: token === "write-approved" || token === "admin" ? ["*"] : [],
  };
}

async function jwtAccessContext(token: string, config: GatewayConfig): Promise<AccessContext> {
  const key = config.jwksUrl
    ? jwksForUrl(config.jwksUrl)
    : new TextEncoder().encode(config.devJwtSecret);
  const verifyOptions: Parameters<typeof jwtVerify>[2] = {
    audience: config.authAudience,
  };
  if (config.authIssuer) {
    verifyOptions.issuer = config.authIssuer;
  }
  if (config.voicePolicy) {
    verifyOptions.requiredClaims = ["exp", "iss", "aud", "sub", "workspace_id", "document_ids", "scope"];
    verifyOptions.algorithms = config.jwksUrl ? ["RS256"] : ["HS256"];
  }
  const { payload } = await jwtVerify(token, key, verifyOptions);
  if (config.voicePolicy && (
    typeof payload.scope !== "string" ||
    payload.scope.split(/[ ,]+/).filter(Boolean).some(scope => !["documents:read", "citations:verify"].includes(scope)) ||
    !Array.isArray(payload.document_ids) || payload.document_ids.some(doc => typeof doc !== "string") ||
    payload.role !== "reader" || payload.approvals !== undefined ||
    (payload.approval_grants !== undefined && (!Array.isArray(payload.approval_grants) || payload.approval_grants.length))
  )) {
    throw new AuthError("Voice JWT claims must be strictly read-only.", 403, "voice_access_denied");
  }
  const workspaceId = stringClaim(payload, "workspace_id") ?? stringClaim(payload, "tenant_id");
  if (!workspaceId) {
    throw new AuthError("JWT is valid but missing workspace_id/tenant_id claim.", 403, "missing_workspace");
  }
  const accessContext: AccessContext = {
    token,
    authMode: "jwt",
    clientId: stringClaim(payload, "client_id") ?? payload.sub ?? "unknown-client",
    userId: payload.sub ?? stringClaim(payload, "user_id") ?? "unknown-user",
    workspaceId,
    role: stringClaim(payload, "role") ?? "reader",
    scopes: scopesFromJwt(payload),
    allowedDocumentIds: stringArrayClaim(payload, "document_ids", "allowed_documents"),
    approvalGrants: stringArrayClaim(payload, "approval_grants", "approvals"),
  };
  if (payload.exp !== undefined) {
    accessContext.expiresAt = payload.exp;
  }
  if (config.voicePolicy) {
    try { config.voicePolicy.assertAccess(accessContext); }
    catch { throw new AuthError("Voice JWT is outside the synthetic demo boundary.", 403, "voice_access_denied"); }
  }
  return accessContext;
}

function scopesForDevToken(token: string, defaultScopes: string[]): string[] {
  if (!token || token === "read") {
    return defaultScopes.length ? defaultScopes : READ_ONLY_SCOPES;
  }
  if (token === "write" || token === "write-approved") {
    return WRITE_SCOPES;
  }
  if (token === "admin") {
    return [...ALL_SCOPES];
  }
  return token
    .split(",")
    .map(scope => scope.trim())
    .filter(scope => ALL_SCOPES.includes(scope as Scope));
}

function scopesFromJwt(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  const scopes = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/[ ,]+/)
      : [];
  return scopes.filter(scope => ALL_SCOPES.includes(scope as Scope));
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayClaim(payload: JWTPayload, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.map(String).filter(Boolean);
    }
    if (typeof value === "string") {
      return value
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function jwksForUrl(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(url);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function clientIdForDevToken(token: string): string {
  if (token === "admin") {
    return "local-admin";
  }
  if (token.startsWith("write")) {
    return "local-writer";
  }
  return "local-reader";
}

function isAccessContext(value: unknown): value is AccessContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AccessContext>;
  return (
    typeof candidate.token === "string" &&
    typeof candidate.clientId === "string" &&
    Array.isArray(candidate.scopes) &&
    typeof candidate.workspaceId === "string"
  );
}
