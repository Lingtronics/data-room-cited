import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sdkPrivacy } from "./sdkPrivacy.js";
export default defineConfig({ plugins: [sdkPrivacy(), react()], test: {
  environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  setupFiles: ["src/testSetup.ts"], restoreMocks: true,
} });
