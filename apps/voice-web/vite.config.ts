import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { webConfig } from "./src/config.js";
import { sdkPrivacy } from "./sdkPrivacy.js";

function localOnly(): Plugin {
  const guard = (server: { config: { server: { host?: string | boolean }; preview: { host?: string | boolean } }; middlewares: { use: Function } }, preview = false) => {
    if ((preview ? server.config.preview.host : server.config.server.host) !== "127.0.0.1") throw new Error("Voice web must bind to 127.0.0.1.");
    server.middlewares.use((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => {
      const host = req.headers.host;
      if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") ||
          ![`localhost:${req.socket.localPort}`, `127.0.0.1:${req.socket.localPort}`].includes(host ?? "") ||
          Object.keys(req.headers).some(key => key === "forwarded" || key.startsWith("x-forwarded-"))) {
        res.writeHead(403); res.end("Local access only."); return;
      }
      next();
    });
  };
  return { name: "voice-local-only", configureServer: server => guard(server), configurePreviewServer: server => guard(server, true) };
}

export default defineConfig(({ mode }) => {
  const config = webConfig(process.env, mode);
  return {
    plugins: [localOnly(), sdkPrivacy(), react()], envPrefix: [],
    define: { __VOICE_WEB_CONFIG__: JSON.stringify(config) },
    optimizeDeps: { exclude: ["@elevenlabs/react", "@elevenlabs/client"] },
    server: { host: "127.0.0.1", port: config.port, strictPort: true, allowedHosts: ["localhost", "127.0.0.1"],
      fs: { strict: true, allow: [resolve(import.meta.dirname), resolve(import.meta.dirname, "../voice-api/dist"), resolve(import.meta.dirname, "../../node_modules")] },
      headers: { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Permissions-Policy": "microphone=(self), camera=()" } },
    preview: { host: "127.0.0.1", port: config.port, strictPort: true, allowedHosts: ["localhost", "127.0.0.1"] },
    build: { sourcemap: false },
  };
});
