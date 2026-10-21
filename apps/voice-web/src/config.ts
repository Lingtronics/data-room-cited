export type WebConfig = { enabled: boolean; mode: "mock" | "live"; apiOrigin: string; maxSessionMs: number; port: number };

// Only this explicit allowlist is serialized into the browser bundle. Never load .env.
export function webConfig(env: Record<string, string | undefined>, commandMode: string): WebConfig {
  const flag = commandMode === "mock" ? "true" : env.VOICE_FEATURE_ENABLED ?? "false";
  const mode = commandMode === "mock" ? "mock" : env.VOICE_WEB_MODE ?? "mock";
  const host = env.VOICE_WEB_HOST ?? "127.0.0.1";
  const port = Number(env.VOICE_WEB_PORT ?? "5173");
  const minutes = Number(env.VOICE_MAX_SESSION_MINUTES ?? "15");
  if (!["true", "false"].includes(flag) || !["mock", "live"].includes(mode) || host !== "127.0.0.1" ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(minutes) || minutes < 1 || minutes > 15) {
    throw new Error("Unsafe voice web configuration; use the local setup guide.");
  }
  const apiOrigin = env.VOICE_API_ORIGIN ?? "http://127.0.0.1:8790";
  if (!isLocalApiOrigin(apiOrigin)) throw new Error("Voice API must use a direct loopback origin.");
  return { enabled: flag === "true", mode: mode as WebConfig["mode"], apiOrigin, maxSessionMs: minutes * 60_000, port };
}
export function isLocalApiOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
      url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
export function isLocalPage(location: Pick<Location, "protocol" | "hostname">): boolean {
  return ["http:", "https:"].includes(location.protocol) && ["localhost", "127.0.0.1"].includes(location.hostname);
}
