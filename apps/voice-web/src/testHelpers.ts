import { vi } from "vitest";
import type { Broker, Session } from "./api.js";
import type { ConversationEvents, Driver } from "./conversation.js";
import { demoEvidence } from "./mock.js";
export const session: Session = { signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_synthetic&conversation_signature=PRIVATE_SIGNATURE", expires_at: new Date(Date.now() + 900000).toISOString() };
export function brokerMock() {
  return { session: vi.fn<Broker["session"]>().mockResolvedValue(session), verify: vi.fn<Broker["verify"]>().mockResolvedValue([demoEvidence]) };
}
export class FakeDriver implements Driver {
  events: ConversationEvents | undefined;
  start = vi.fn<Driver["start"]>((_session, _text, events) => { this.events = events; });
  end = vi.fn<Driver["end"]>().mockResolvedValue(undefined);
  send = vi.fn<Driver["send"]>();
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
