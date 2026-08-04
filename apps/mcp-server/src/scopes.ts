import type { AuthInfo } from "@modelcontextprotocol/server";

import { ALL_SCOPES, type Scope } from "./config.js";

const READ_ONLY_SCOPES: Scope[] = ["documents:read", "citations:verify"];
const WRITE_SCOPES: Scope[] = ["documents:read", "citations:verify", "index:write", "exports:write"];

export function authInfoFromAuthorization(
  authorizationHeader: string | string[] | undefined,
  defaultScopes: string[],
): AuthInfo {
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "read";
  return {
    token,
    clientId: clientIdForToken(token),
    scopes: scopesForToken(token, defaultScopes),
  };
}

export function hasScope(scopes: readonly string[], requiredScope: Scope): boolean {
  return scopes.includes(requiredScope) || scopes.includes("admin:connectors");
}

export function scopesForToken(token: string, defaultScopes: string[]): string[] {
  if (!token || token === "read") {
    return defaultScopes.length ? defaultScopes : READ_ONLY_SCOPES;
  }
  if (token === "write") {
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

function clientIdForToken(token: string): string {
  if (token === "admin") {
    return "local-admin";
  }
  if (token === "write") {
    return "local-writer";
  }
  return "local-reader";
}
