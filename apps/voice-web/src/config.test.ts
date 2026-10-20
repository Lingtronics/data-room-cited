import { describe, expect, it, vi } from "vitest";
import { webConfig, isLocalPage } from "./config.js";
import { sanitizeSdkModule } from "../sdkPrivacy.js";
describe("browser configuration", () => {
  it("disables voice by default and serializes only public values", () => {
    const config = webConfig({ ELEVENLABS_API_KEY: "PRIVATE_KEY", VOICE_MCP_SERVICE_TOKEN: "PRIVATE_TOKEN", VITE_SECRET: "PRIVATE" }, "development");
    expect(config.enabled).toBe(false); expect(JSON.stringify(config)).not.toContain("PRIVATE");
    expect(webConfig({}, "mock")).toMatchObject({ enabled: true, mode: "mock" });
  });
  it.each([
    { VOICE_FEATURE_ENABLED: "yes" }, { VOICE_WEB_MODE: "other" }, { VOICE_WEB_HOST: "0.0.0.0" },
    { VOICE_WEB_PORT: "0" }, { VOICE_WEB_PORT: "65536" }, { VOICE_MAX_SESSION_MINUTES: "0" },
    { VOICE_MAX_SESSION_MINUTES: "16" }, { VOICE_MAX_SESSION_MINUTES: "1.5" },
    { VOICE_API_ORIGIN: "https://public.test" }, { VOICE_API_ORIGIN: "http://user:SECRET@127.0.0.1:8790" },
  ])("refuses unsafe settings", env => { expect(() => webConfig(env, "development")).toThrow(); });
  it.each(["evil.test", "localhost.evil.test", "192.168.1.2"])("refuses nonlocal browser host %s", hostname => {
    expect(isLocalPage({ protocol: "https:", hostname })).toBe(false);
  });
  it("requires an HTTP local page", () => {
    expect(isLocalPage({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(isLocalPage({ protocol: "file:", hostname: "" })).toBe(false);
  });
});
describe("scoped SDK diagnostic privacy", () => {
  it("prevents raw SDK log arguments reaching the console without replacing globals", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = console.error;
    const source = 'console.error("PRIVATE_SIGNED_URL", { quote: "PRIVATE_QUOTE" });';
    const code = sanitizeSdkModule(source, "/node_modules/@elevenlabs/client/dist/BaseConversation.js");
    expect(code).toBeDefined(); Function(code!)(); expect(log).not.toHaveBeenCalled(); expect(console.error).toBe(before);
    expect(sanitizeSdkModule(source, "/src/application.js")).toBeUndefined();
  });
  it("covers React teardown logs and default logger references on Windows paths", () => {
    const code = sanitizeSdkModule("const handler = console.warn; handler('PRIVATE');", "C:\\repo\\node_modules\\@elevenlabs\\react\\dist\\conversation\\ConversationProvider.js?v=123");
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined); Function(code!)(); expect(log).not.toHaveBeenCalled();
  });
});
