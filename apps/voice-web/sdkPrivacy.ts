import type { Plugin } from "vite";
import { readFileSync } from "node:fs";

const filename = (id: string) => id.split("?", 1)[0]!;
const isSdk = (id: string) => /\/node_modules\/@elevenlabs\/(?:react|client)\/.+\.js$/.test(filename(id).replaceAll("\\", "/"));

// The pinned SDK logs raw callback context in some error paths. Scope the logger
// substitution to its ESM modules, in dev, tests and builds; never replace globals.
export function sanitizeSdkModule(code: string, id: string): string | undefined {
  if (!isSdk(id)) return;
  if (!/\bconsole\.(?:log|warn|error|info|debug|trace)\b/.test(code)) return;
  return "const __voiceSdkConsole = Object.freeze({log(){},warn(){},error(){},info(){},debug(){},trace(){}});\n" +
    code.replace(/\bconsole\.(log|warn|error|info|debug|trace)\b/g, "__voiceSdkConsole.$1");
}
export function sdkPrivacy(): Plugin {
  return { name: "voice-sdk-private-diagnostics", enforce: "pre",
    // These packages reference unpublished sources. Drop only their dangling
    // map comments; production builds do not publish source maps either.
    load(id) { if (isSdk(id)) return readFileSync(filename(id), "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, ""); },
    transform: sanitizeSdkModule };
}
