import { VoiceError } from "./errors.js";

/** Global, bounded process counters. Headers/IP aliases cannot allocate buckets. */
export class LocalLimits {
  private windowStart: number;
  private requests = 0;
  private sessions = 0;
  constructor(private readonly requestsPerMinute: number, private readonly maxSessions: number,
    private readonly now: () => number = Date.now) { this.windowStart = now(); }

  request(): void {
    const time = this.now();
    if (time - this.windowStart >= 60_000) { this.windowStart = time; this.requests = 0; }
    if (this.requests >= this.requestsPerMinute) throw new VoiceError("rate_limited");
    this.requests++;
  }

  reserveSession(): void {
    if (this.sessions >= this.maxSessions) throw new VoiceError("session_limit_reached");
    // Count attempts conservatively, including timeouts whose upstream outcome is unknown.
    this.sessions++;
  }
}
