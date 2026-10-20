import * as z from "zod/v4";

export const CoreErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const ApiSuccessSchema = z.object({
  ok: z.literal(true),
  correlation_id: z.string(),
  data: z.unknown(),
});

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  correlation_id: z.string(),
  error: CoreErrorSchema,
});

export const ApiEnvelopeSchema = z.discriminatedUnion("ok", [ApiSuccessSchema, ApiErrorSchema]);
export const ToolEnvelopeSchema = z.union([ApiSuccessSchema, ApiErrorSchema]);

export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

export const NoInputSchema = z.object({});

export const SearchDataRoomInputSchema = z.object({
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(50).optional(),
  semantic: z.boolean().optional(),
});

export const VerifyCitationInputSchema = z.object({
  chunk_id: z.string().min(1),
  quote: z.string().min(1),
});

export const VoiceSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(2_000),
  top_k: z.number().int().min(1).max(5).default(5),
  semantic: z.literal(false).default(false),
});
export const VoiceVerifyInputSchema = z.strictObject({
  chunk_id: z.string().trim().min(1).max(200),
  quote: z.string().trim().min(1).max(5_000),
});

export const FindSupportingEvidenceInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

export const GetAssetLineageInputSchema = z.object({
  asset_id: z.string().min(1),
  depth: z.number().int().min(1).max(5).optional(),
});

export const RebuildIndexInputSchema = z.object({
  contextualize: z.boolean().nullable().optional(),
});

export const SyncDocumentSourceInputSchema = z.object({
  rebuild: z.boolean().optional(),
  contextualize: z.boolean().nullable().optional(),
});

export const ExportPowerPointOutlineInputSchema = z.object({
  title: z.string().min(1),
  outline_markdown: z.string().min(1),
  filename: z.string().min(1).optional(),
});

export const RiskReviewPromptArgsSchema = z.object({
  focus: z.string().min(1).default("commercial, contract, customer, management, and market risks"),
});

export const ContractConcentrationPromptArgsSchema = z.object({
  threshold: z.string().min(1).default("top ten customer contracts and any ARR concentration"),
});

export const EvidenceGapPromptArgsSchema = z.object({
  workstream: z.string().min(1).default("commercial due diligence"),
});
