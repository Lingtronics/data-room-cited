// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { demoEvidence } from "./mock.js";
describe("synthetic demo provenance", () => {
  it("uses a real approved fixture excerpt and metadata for its canned response", () => {
    const chunks = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../fixtures/voice/index/chunks.json"), "utf8")) as { chunk_id: string; doc: string; text: string; section_title: string }[];
    const chunk = chunks.find(item => item.chunk_id === demoEvidence.chunk_id)!;
    expect(chunk.text).toContain(demoEvidence.quote); expect(chunk.doc).toBe(demoEvidence.document); expect(chunk.section_title).toBe(demoEvidence.section_title);
  });
});
