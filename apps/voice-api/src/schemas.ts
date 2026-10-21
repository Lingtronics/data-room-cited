import * as z from "zod/v4";

// Return plain text in JSON. Reject invisible display controls; never turn
// untrusted markup into HTML or remove characters before verification.
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value));
export const SessionInput = z.strictObject({});
export const EvidenceItem = z.strictObject({ chunk_id: text(200), quote: text(5000) });
export const EvidenceInput = z.strictObject({ items: z.array(EvidenceItem).min(1).max(5) });
export type Evidence = z.infer<typeof EvidenceItem>;
// Browser-safe contracts exported without server configuration, tokens or Node imports.
export const EvidenceResultSchema = z.discriminatedUnion("verified", [
  z.strictObject({ chunk_id: text(200), verified: z.literal(false) }),
  z.strictObject({ chunk_id: text(200), verified: z.literal(true), document: text(200),
    page_label: z.null(), section_title: text(200), quote: text(5000) }),
]);
export const EvidenceResponse = z.strictObject({ items: z.array(EvidenceResultSchema).min(1).max(5) });
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const VerificationEnvelope = z.strictObject({
  ok: z.literal(true), correlation_id: z.string().min(1).max(200),
  data: z.discriminatedUnion("verified", [
    z.strictObject({ verified: z.literal(false), reason: z.literal("quote_not_found_in_source_text"),
      chunk_id: text(200), quote: text(5000) }),
    z.strictObject({ verified: z.literal(true), reason: z.literal("verified"),
      chunk_id: text(200), quote: text(5000), document: text(200), page_label: z.null(), section_title: text(200) }),
  ]),
});
