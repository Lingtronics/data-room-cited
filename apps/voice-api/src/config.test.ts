import { describe, expect, it } from "vitest";
import { loadVoiceConfig } from "./config.js";
import { LocalLimits } from "./limits.js";
import { configEnv } from "./testSupport.js";

describe("voice broker configuration", () => {
  it("requires no credentials when disabled", () => {
    expect(loadVoiceConfig({})).toEqual({ enabled: false });
    expect(loadVoiceConfig({ VOICE_FEATURE_ENABLED: "false", VOICE_MCP_SERVICE_TOKEN: "junk" })).toEqual({ enabled: false });
  });
  it("allows missing provider credentials so evidence-only local tests work", () => {
    const config = loadVoiceConfig({ ...configEnv(), ELEVENLABS_API_KEY: "", ELEVENLABS_AGENT_ID: "" });
    expect(config.enabled).toBe(true);
  });
  it.each([
    ["VOICE_FEATURE_ENABLED", "typo"], ["VOICE_READ_ONLY_DEMO", "false"], ["VOICE_API_HOST", "0.0.0.0"],
    ["VOICE_ALLOWED_ORIGINS", "*"], ["VOICE_ALLOWED_ORIGINS", "https://evil.test"],
    ["VOICE_ALLOWED_ORIGINS", "http://localhost:5173/path"], ["VOICE_ALLOWED_ORIGINS", "null"],
    ["VOICE_ALLOWED_ORIGINS", "http://localhost:5173,"], ["VOICE_API_PORT", "8790oops"],
    ["VOICE_API_PORT", "0"], ["VOICE_API_PORT", "65536"], ["VOICE_REQUESTS_PER_MINUTE", "0"],
    ["VOICE_MAX_SESSIONS", "101"], ["VOICE_UPSTREAM_TIMEOUT_MS", "999999"],
    ["VOICE_MCP_BASE_URL", "https://remote.test/mcp"], ["VOICE_MCP_BASE_URL", "http://127.0.0.1:8787/mcp?token=SECRET"],
    ["VOICE_MCP_BASE_URL", "http://SECRET@127.0.0.1:8787/mcp"], ["VOICE_MCP_SERVICE_TOKEN", "read"],
    ["VOICE_MCP_SERVICE_TOKEN", ""], ["VOICE_FIXTURE_DATA_DIR", "data"],
    ["ELEVENLABS_API_KEY", "SECRET\nheader"], ["ELEVENLABS_AGENT_ID", "agent_foo?SECRET"],
  ])("refuses unsafe %s without echoing values", (key, value) => {
    try { loadVoiceConfig({ ...configEnv(), [key]: value }); expect.fail("Expected configuration rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "config_invalid" }); expect(String(error)).not.toContain("SECRET"); }
  });
});

describe("global local limits", () => {
  it("resets request quota by time but never resets issuance budget automatically", () => {
    let now = 0;
    const limits = new LocalLimits(1, 1, () => now);
    limits.request(); limits.reserveSession();
    expect(() => limits.request()).toThrow("Local request limit");
    expect(() => limits.reserveSession()).toThrow("Local session issuance limit");
    now = 60_000;
    limits.request();
    expect(() => limits.reserveSession()).toThrow("Local session issuance limit");
  });
});
