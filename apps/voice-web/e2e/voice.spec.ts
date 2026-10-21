import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoEvidence, demoItem } from "../src/mock.js";

test.beforeEach(async ({ page }) => {
  // Fail closed: these tests must never reach an external provider or remote host.
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("mock demo passes start, source check, rejection, disconnect and retry without external calls", async ({ page }) => {
  const requests: string[] = []; const errors: string[] = [];
  page.on("request", request => requests.push(request.url())); page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("MOCK DEMO", { exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Start mock demo" }); await start.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("verified-citation")).toContainText(demoItem.quote);
  await expect(page.getByText("1 unsupported citation withheld.")).toBeVisible();
  await expect(page.getByRole("log")).toContainText("ninety days");
  await page.screenshot({ path: "test-results/voice-m3-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "End conversation" }).click();
  await expect(start).toBeVisible(); await expect(page.getByTestId("verified-citation")).toHaveCount(0);
  await expect(page.getByRole("log")).not.toContainText("ninety days");
  await start.click(); await expect(page.getByTestId("verified-citation")).toBeVisible();
  expect(requests.some(url => /elevenlabs|\/api\/voice\//.test(url))).toBe(false); expect(errors).toEqual([]);
});

test("unsupported and unavailable mock evidence never becomes a citation", async ({ page }) => {
  await page.goto("/");
  for (const scenario of ["unsupported", "unavailable"]) {
    await page.getByLabel("Demo scenario").selectOption(scenario); await page.getByRole("button", { name: "Start mock demo" }).click();
    if (scenario === "unavailable") await expect(page.getByRole("alert")).toContainText("evidence service is unavailable");
    else await expect(page.getByText("1 unsupported citation withheld.")).toBeVisible();
    await expect(page.getByTestId("verified-citation")).toHaveCount(0);
    await expect(page.getByText("No verified citations for this answer")).toBeVisible();
    await page.getByRole("button", { name: "End conversation" }).click(); await expect(page.getByRole("button", { name: "Start mock demo" })).toBeVisible();
  }
});

test("mobile layout fits and honours reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/"); await page.getByRole("button", { name: "Start mock demo" }).click();
  await expect(page.getByTestId("verified-citation")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".orb-core span").first().evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await page.screenshot({ path: "test-results/voice-m3-mobile.png", fullPage: true });
});

test("feature-disabled page exposes no conversation controls or provider requests", async ({ page }) => {
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  await page.goto("http://127.0.0.1:5175");
  await expect(page.getByRole("heading", { name: "Voice research is disabled" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0); expect(requests.some(url => /elevenlabs|\/api\/voice\//.test(url))).toBe(false);
});

test("real React SDK hooks use mocked WebSocket and local API contracts, then clear on end", async ({ page }) => {
  const sent: Record<string, unknown>[] = []; const diagnostics: string[] = []; const verificationCalls: unknown[] = [];
  page.on("console", message => { if (!["debug", "info"].includes(message.type())) diagnostics.push(message.text()); });
  page.on("pageerror", error => diagnostics.push(error.message));
  let socket: Parameters<Parameters<Page["routeWebSocket"]>[1]>[0] | undefined;
  await mockApi(page, verificationCalls);
  await page.routeWebSocket("wss://api.elevenlabs.io/**", ws => {
    socket = ws;
    ws.onMessage(message => {
      const data = JSON.parse(String(message)) as Record<string, unknown>; sent.push(data);
      if (data.type === "conversation_initiation_client_data") {
        ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
          conversation_id: "mock-conversation", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000" } }));
      }
    });
  });
  await page.goto("http://127.0.0.1:5174"); await page.getByLabel("Text only").check();
  await page.getByRole("button", { name: "Start text" }).click();
  await expect(page.getByText("Ready for your message")).toBeVisible();
  socket!.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "A synthetic contract has a renewal notice window.", event_id: 1 } }));
  socket!.send(JSON.stringify({ type: "client_tool_call", client_tool_call: { tool_name: "displayEvidence", tool_call_id: "mock-tool-1", parameters: { items: [demoItem] }, expects_response: true } }));
  await expect(page.getByTestId("verified-citation")).toContainText(demoEvidence.document);
  await expect.poll(() => sent.some(item => item.type === "client_tool_result" && item.tool_call_id === "mock-tool-1")).toBe(true);
  expect(verificationCalls).toEqual([{ items: [demoItem] }]);
  await page.getByLabel("Your message").fill("Only discuss 2025"); await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sent.some(item => item.type === "user_message" && item.text === "Only discuss 2025")).toBe(true);
  await expect(page.getByTestId("verified-citation")).toHaveCount(0);
  await page.getByRole("button", { name: "End conversation" }).click(); await expect(page.getByRole("button", { name: "Start text" })).toBeVisible();
  await page.getByRole("button", { name: "Start text" }).click(); await expect(page.getByText("Ready for your message")).toBeVisible();
  socket!.send(JSON.stringify({ type: "error", error_event: { error_type: "test_error", message: "PRIVATE_SIGNATURE PRIVATE_QUOTE", debug_message: "PRIVATE_SIGNATURE" } }));
  await expect(page.getByRole("alert")).toContainText("conversation disconnected");
  expect(diagnostics.join(" ")).not.toContain("PRIVATE_SIGNATURE"); expect(diagnostics.join(" ")).not.toContain(demoItem.quote);
  expect(diagnostics.join(" ")).not.toContain("PRIVATE_QUOTE");
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("microphone rejection never issues a session and remains recoverable", async ({ page }) => {
  let sessions = 0;
  await page.route("http://127.0.0.1:8790/**", route => { sessions++; return route.abort(); });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("PRIVATE", "NotAllowedError"); }; });
  await page.goto("http://127.0.0.1:5174"); await expect(page.getByText(/ElevenLabs processes your audio/)).toBeVisible();
  await page.getByRole("button", { name: "Start voice" }).click(); await expect(page.getByRole("alert")).toContainText("Microphone access was denied");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible(); expect(sessions).toBe(0);
});

test("SDK voice mode releases every fake microphone track after End", async ({ page, context }) => {
  await context.grantPermissions(["microphone"], { origin: "http://127.0.0.1:5174" });
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = []; (window as unknown as { testStreams: MediaStream[] }).testStreams = streams;
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); streams.push(stream); return stream; };
  });
  await mockApi(page, []);
  await page.routeWebSocket("wss://api.elevenlabs.io/**", ws => {
    ws.onMessage(message => {
      if (JSON.parse(String(message)).type === "conversation_initiation_client_data") ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
        conversation_id: "mock-voice", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000" } }));
    });
  });
  await page.goto("http://127.0.0.1:5174"); await page.getByRole("button", { name: "Start voice" }).click();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => (window as unknown as { testStreams: MediaStream[] }).testStreams.length)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "End conversation" }).click(); await expect(page.getByRole("button", { name: "Start voice" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { testStreams: MediaStream[] }).testStreams.flatMap(stream => stream.getTracks()).every(track => track.readyState === "ended"))).toBe(true);
});

test("UI server rejects Host and proxy spoofing and does not serve repository secrets", async ({ request }) => {
  for (const headers of [{ host: "evil.test" }, { "x-forwarded-for": "127.0.0.1" }]) {
    expect((await request.get("http://127.0.0.1:5173", { headers })).status()).toBe(403);
  }
  const folder = mkdtempSync(join(tmpdir(), "voice-web-denied-"));
  const secret = join(folder, ".env");
  writeFileSync(secret, "SYNTHETIC_SECRET_SENTINEL=never_expose\n");
  try {
    const response = await request.get(`http://127.0.0.1:5173/@fs/${secret.replaceAll("\\", "/")}`);
    expect(response.status()).toBe(403); expect(await response.text()).not.toContain("SYNTHETIC_SECRET_SENTINEL");
  } finally { unlinkSync(secret); rmdirSync(folder); }
});

async function mockApi(page: Page, verificationCalls: unknown[]) {
  await page.route("http://127.0.0.1:8790/api/voice/**", async route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "http://127.0.0.1:5174", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "content-type": "application/json" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    expect(request.headers().authorization).toBeUndefined();
    if (request.url().endsWith("/session")) {
      expect(request.postDataJSON()).toEqual({});
      await route.fulfill({ headers, json: { signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_synthetic&conversation_signature=PRIVATE_SIGNATURE", expires_at: new Date(Date.now() + 900000).toISOString() } });
    } else {
      verificationCalls.push(request.postDataJSON()); await route.fulfill({ headers, json: { items: [demoEvidence] } });
    }
  });
}
