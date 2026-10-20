const errors = {
  feature_disabled: [404, "Voice feature is disabled."],
  config_invalid: [503, "Voice configuration is missing or unsafe; check the local setup guide."],
  config_missing: [503, "Configure the server-side ElevenLabs key and fixed agent ID."],
  local_only: [403, "Only direct local requests are permitted."],
  origin_denied: [403, "A configured local Origin is required."],
  not_found: [404, "Unknown voice API route."],
  method_not_allowed: [405, "Use POST with a JSON body."],
  invalid_request: [400, "Request does not match the voice API schema."],
  body_too_large: [413, "Request exceeds the voice API size limit."],
  unsupported_media_type: [415, "Use application/json."],
  rate_limited: [429, "Local request limit reached; try again later."],
  session_limit_reached: [429, "Local session issuance limit reached."],
  session_upstream_failed: [502, "The voice provider could not issue a session URL."],
  session_invalid_response: [502, "The voice provider returned an invalid session response."],
  session_timeout: [504, "The voice provider timed out."],
  fixture_unavailable: [503, "The approved synthetic fixture is unavailable."],
  mcp_unavailable: [503, "The read-only demo MCP gateway is unavailable or unauthorized."],
  mcp_unsafe: [503, "The MCP gateway does not match the approved read-only demo profile."],
  mcp_timeout: [504, "Evidence verification timed out."],
  evidence_not_allowed: [403, "An evidence item is outside the approved fixture or service scope."],
  verification_failed: [502, "The gateway returned an invalid verification response."],
  internal_error: [500, "Voice request failed."],
} as const;

export type ErrorCode = keyof typeof errors;
export class VoiceError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
export function safeError(error: unknown): VoiceError {
  return error instanceof VoiceError ? error : new VoiceError("internal_error");
}
