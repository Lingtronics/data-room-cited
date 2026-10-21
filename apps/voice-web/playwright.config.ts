import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", fullyParallel: false, workers: 1, timeout: 25_000,
  reporter: "list", outputDir: "test-results", retries: 0,
  use: { browserName: "chromium", ...(process.env.VOICE_TEST_BROWSER_CHANNEL ? { channel: process.env.VOICE_TEST_BROWSER_CHANNEL } : {}),
    baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 1100 }, trace: "off", video: "off",
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } },
  webServer: [
    { command: "pnpm exec vite --mode mock", url: "http://127.0.0.1:5173", reuseExistingServer: false, env: { VOICE_WEB_PORT: "5173" } },
    { command: "pnpm exec vite --mode e2e-live", url: "http://127.0.0.1:5174", reuseExistingServer: false,
      env: { VOICE_FEATURE_ENABLED: "true", VOICE_WEB_MODE: "live", VOICE_WEB_PORT: "5174", VOICE_API_ORIGIN: "http://127.0.0.1:8790" } },
    { command: "pnpm exec vite --mode e2e-disabled", url: "http://127.0.0.1:5175", reuseExistingServer: false,
      env: { VOICE_FEATURE_ENABLED: "false", VOICE_WEB_PORT: "5175" } },
  ],
});
