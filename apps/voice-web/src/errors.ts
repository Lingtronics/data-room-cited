export const errorMessages = {
  microphone_denied: "Microphone access was denied. Allow it in your browser, or start a text conversation.",
  microphone_unavailable: "A microphone is unavailable. Check your device, or start a text conversation.",
  permission_timeout: "Microphone permission is still pending. Dismiss the browser prompt, then try again or use text.",
  config_missing: "The local voice service needs its provider key and fixed agent configuration.",
  session_failed: "A voice session could not be created. Check the local service and try again.",
  connection_lost: "The conversation disconnected. Start again to create a fresh session.",
  connection_timeout: "The voice connection timed out. Check the local service and try again.",
  mcp_unavailable: "The read-only evidence service is unavailable. No sources have been verified.",
  verification_failed: "The evidence could not be verified. No unverified sources are displayed.",
  invalid_evidence: "The requested evidence did not match the allowed format.",
  rate_limited: "The local request or session limit was reached. Check the local service before retrying.",
  local_only: "Voice research is available only from this computer's local development page.",
  cleanup_failed: "Session cleanup could not be confirmed. Close this tab before starting again.",
} as const;
export type ErrorCode = keyof typeof errorMessages;
export class UiError extends Error {
  constructor(readonly code: ErrorCode) { super(errorMessages[code]); }
}
export function safeCode(error: unknown, fallback: ErrorCode): ErrorCode { return error instanceof UiError ? error.code : fallback; }
