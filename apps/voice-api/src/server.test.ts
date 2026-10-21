import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { apiKey, configEnv } from "./testSupport.js";

function run(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", bytes => { output += String(bytes); });
    child.stderr.on("data", bytes => { output += String(bytes); });
    child.on("error", reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error("API entry point did not exit safely.")); }, 5000);
    child.on("exit", code => { clearTimeout(timer); done({ code, output }); });
  });
}

describe("voice API executable startup", () => {
  it("exits successfully with no listener when the feature is disabled", async () => {
    const result = await run({ VOICE_FEATURE_ENABLED: "false" });
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe('{"event":"voice_feature_disabled"}');
  });
  it("rejects a public bind without revealing configuration values", async () => {
    const result = await run({ ...configEnv(), VOICE_API_HOST: "0.0.0.0" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("config_invalid");
    expect(result.output).not.toContain(apiKey);
    expect(result.output).not.toContain("test.jwt.placeholder");
  });
  it("rejects a malformed service JWT before network access", async () => {
    const result = await run(configEnv());
    expect(result.code).toBe(1);
    expect(result.output).toContain("mcp_unavailable");
    expect(result.output).not.toContain(apiKey);
    expect(result.output).not.toContain("test.jwt.placeholder");
  });
});
