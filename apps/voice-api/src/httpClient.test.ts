import { describe, expect, it, vi } from "vitest";
import { limitedText } from "./httpClient.js";

describe("bounded upstream response reader", () => {
  it("decodes UTF-8 split across stream chunks", async () => {
    const data = new TextEncoder().encode("Synthetic café");
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(data.slice(0, -1)); controller.enqueue(data.slice(-1)); controller.close();
    } });
    expect(await limitedText(new Response(body), data.length)).toBe("Synthetic café");
  });
  it("cancels an oversized stream without including its contents in the error", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(new TextEncoder().encode("SECRET"));
    }, cancel });
    const result = limitedText(new Response(body), 5);
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toThrow("SECRET");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects a missing body", async () => {
    await expect(limitedText(new Response(null))).rejects.toThrow();
  });
});
