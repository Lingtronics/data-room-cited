import { createVoiceApi } from "./app.js";
import { loadVoiceConfig } from "./config.js";
import { safeError } from "./errors.js";

try {
  const config = loadVoiceConfig();
  const app = createVoiceApi(config);
  await app.start();
  console.log(JSON.stringify({ event: config.enabled ? "voice_api_listening" : "voice_feature_disabled" }));
  const stop = () => { app.server.close(); app.server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  const failure = safeError(error);
  console.error(JSON.stringify({ event: "voice_api_startup_failed", error_code: failure.code, message: failure.message }));
  process.exitCode = 1;
}
