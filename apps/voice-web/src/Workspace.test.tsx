import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MockApp from "./MockApp.js";
import { Workspace } from "./Workspace.js";
import { ConversationController } from "./conversation.js";
import { brokerMock, FakeDriver, flush } from "./testHelpers.js";
import { demoItem, demoEvidence } from "./mock.js";
import { UiError } from "./errors.js";
const config = { enabled: true, mode: "mock" as const, apiOrigin: "http://127.0.0.1:8790", port: 5173, maxSessionMs: 900000 };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("rendered mock research workspace", () => {
  it("runs start, transcript/status, valid/invalid evidence, end and restart without microphone or network", async () => {
    vi.useFakeTimers(); const fetcher = vi.spyOn(globalThis, "fetch");
    const microphone = vi.fn(); Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: microphone } });
    render(<MockApp config={config} />);
    expect(screen.getByText(/No microphone, credentials or provider connection/)).toBeTruthy();
    expect(screen.getByText("No verified citations for this answer")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start mock demo" })); });
    expect(screen.getByRole("button", { name: "Cancel connection" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("Assistant speaking")).toBeTruthy();
    expect(screen.getByText(/Verified in mock/)).toBeTruthy(); expect(screen.getByText("1 unsupported citation withheld.")).toBeTruthy();
    expect(screen.getByRole("log").textContent).toContain("ninety days");
    expect(screen.queryByText("Alder generates 900 billion in revenue.")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled(); expect(microphone).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "End conversation" })); });
    expect(screen.getByText("Ending conversation")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(101); });
    expect(screen.queryByTestId("verified-citation")).toBeNull(); expect(screen.getByRole("log").textContent).not.toContain("ninety days");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start mock demo" })); await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByTestId("verified-citation")).toBeTruthy();
  });
  it.each(["unsupported", "unavailable"])("keeps %s results out of the citation panel", async scenario => {
    vi.useFakeTimers(); render(<MockApp config={config} />);
    fireEvent.change(screen.getByLabelText("Demo scenario"), { target: { value: scenario } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start mock demo" })); await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByTestId("verified-citation")).toBeNull(); expect(screen.getByText("No verified citations for this answer")).toBeTruthy();
    if (scenario === "unavailable") expect(screen.getByRole("alert").textContent).toContain("read-only evidence service is unavailable");
  });
});
describe("live-mode UI with mocked services", () => {
  function setup() {
    const broker = brokerMock(); const driver = new FakeDriver();
    const microphone = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    const controller = new ConversationController(broker, driver, { mock: false, maxSessionMs: 900000, microphone });
    const view = render(<Workspace controller={controller} mock={false} maxMinutes={15} />);
    return { broker, driver, controller, microphone, view };
  }
  it("shows the third-party disclosure before any permission request", () => {
    const { microphone, broker } = setup();
    expect(screen.getByText(/ElevenLabs processes your audio/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start voice" })).toBeTruthy();
    expect(microphone).not.toHaveBeenCalled(); expect(broker.session).not.toHaveBeenCalled();
  });
  it("shows microphone denial and offers an explicit text-only retry", async () => {
    const { microphone, broker, driver } = setup(); microphone.mockRejectedValue(new DOMException("SECRET", "NotAllowedError"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start voice" })); });
    expect(screen.getByRole("alert").textContent).toContain("Microphone access was denied"); expect(broker.session).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Text only"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(driver.start.mock.calls[0]?.[1]).toBe(true); expect(microphone).toHaveBeenCalledOnce();
  });
  it("shows recoverable configuration errors without raw details", async () => {
    const { broker } = setup(); broker.session.mockRejectedValueOnce(new UiError("config_missing"));
    fireEvent.click(screen.getByLabelText("Text only"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start text" })); });
    expect(screen.getByRole("alert").textContent).toContain("fixed agent configuration");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(broker.session).toHaveBeenCalledTimes(2);
  });
  it("renders transcript and verified source markup as inert text", async () => {
    const { controller, driver, broker } = setup(); const markup = '<img src=x onerror="alert(1)"><script>secret()</script>';
    await act(async () => { await controller.start("text"); driver.events!.connected(); });
    broker.verify.mockResolvedValue([{ ...demoEvidence, quote: markup, document: "<script>document</script>" }]);
    await act(async () => { driver.events!.message("agent", markup, 1); await driver.events!.evidence({ items: [{ ...demoItem, quote: markup }] }); });
    expect(screen.getByTestId("verified-citation").textContent).toContain(markup);
    expect(document.querySelectorAll("img,script").length).toBe(0); expect(screen.getByRole("log").textContent).toContain(markup);
    expect(screen.getByText("Conversation text is not an independently verified documentary claim.")).toBeTruthy();
  });
  it("sends bounded text, clears session contents and ends on pagehide/unmount", async () => {
    const { controller, driver, view } = setup();
    await act(async () => { await controller.start("text"); driver.events!.connected(); });
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "synthetic question" } }); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(driver.send).toHaveBeenCalledWith("synthetic question");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await flush(); });
    expect(screen.getByRole("button", { name: "Start voice" })).toBeTruthy();
    await act(async () => { await controller.start("text"); driver.events!.connected(); });
    const old = driver.events!; view.unmount(); await flush();
    expect(driver.end).toHaveBeenCalledTimes(2); old.message("agent", "stale", 90); expect(controller.getSnapshot().transcript).toEqual([]);
    const second = setup(); expect(second.controller.getSnapshot().phase).toBe("idle");
  });
});
