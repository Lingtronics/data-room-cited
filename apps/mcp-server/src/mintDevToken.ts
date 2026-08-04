import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.MCP_DEV_JWT_SECRET ?? "local-dev-only-change-me");
const audience = process.env.MCP_AUTH_AUDIENCE ?? "http://127.0.0.1:8787/mcp";
const issuer = process.env.MCP_AUTH_ISSUER ?? "data-room-cited-local";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key === "--") {
    index -= 1;
    continue;
  }
  if (key?.startsWith("--") && value) {
    args.set(key.slice(2), value);
  }
}

const scope = args.get("scope") ?? "documents:read citations:verify";
const workspaceId = args.get("workspace") ?? "local";
const subject = args.get("sub") ?? "local-user";
const role = args.get("role") ?? "reader";
const documentIds = splitOptional(args.get("documents"));
const approvalGrants = splitOptional(args.get("approvals"));

const token = await new SignJWT({
  scope,
  workspace_id: workspaceId,
  role,
  document_ids: documentIds,
  approval_grants: approvalGrants,
})
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuer(issuer)
  .setAudience(audience)
  .setSubject(subject)
  .setIssuedAt()
  .setExpirationTime(args.get("expires-in") ?? "15m")
  .sign(secret);

console.log(token);

function splitOptional(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}
