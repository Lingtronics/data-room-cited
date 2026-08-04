import type { AccessContext } from "./auth.js";
import type { ApiEnvelope } from "./schemas.js";

export function filterEnvelopeForAccess(
  envelope: ApiEnvelope,
  accessContext: AccessContext,
): ApiEnvelope {
  if (!envelope.ok || !isRestricted(accessContext)) {
    return envelope;
  }
  const data = filterData(envelope.data, accessContext);
  return { ...envelope, data };
}

export function forbiddenEnvelope(
  correlationId: string,
  accessContext: AccessContext,
  message: string,
): ApiEnvelope {
  return {
    ok: false,
    correlation_id: correlationId,
    error: {
      code: "forbidden_document",
      message: `${message} Workspace '${accessContext.workspaceId}' is not permitted to access this document.`,
    },
  };
}

function filterData(data: unknown, accessContext: AccessContext): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const copy = structuredClone(data) as Record<string, unknown>;

  if (Array.isArray(copy.results)) {
    copy.results = copy.results.filter(item => itemAllowsDocument(item, accessContext));
  }
  if (Array.isArray(copy.documents)) {
    copy.documents = copy.documents.filter(item => itemAllowsDocument(item, accessContext));
  }
  if (Array.isArray(copy.matches)) {
    copy.matches = copy.matches.filter(item => itemAllowsDocument(item, accessContext));
  }
  if (Array.isArray(copy.evidence)) {
    copy.evidence = copy.evidence
      .map(item => filterEvidenceNode(item, accessContext))
      .filter(Boolean);
  }
  if (copy.asset && !itemAllowsDocument(copy.asset, accessContext)) {
    return {
      found: false,
      error: "Document access denied for this asset.",
    };
  }
  if (copy.chunk && !itemAllowsDocument(copy.chunk, accessContext)) {
    return {
      found: false,
      error: "Document access denied for this chunk.",
    };
  }
  if (Array.isArray(copy.lineage)) {
    copy.lineage = copy.lineage.filter(item => lineageAllowsDocument(item, accessContext));
  }
  return copy;
}

function filterEvidenceNode(item: unknown, accessContext: AccessContext): unknown {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const copy = structuredClone(item) as Record<string, unknown>;
  if (Array.isArray(copy.provenance)) {
    const provenance = copy.provenance.filter(item =>
      itemAllowsDocument(item, accessContext),
    );
    copy.provenance = provenance;
    return provenance.length ? copy : undefined;
  }
  return itemAllowsDocument(copy, accessContext) ? copy : undefined;
}

function lineageAllowsDocument(item: unknown, accessContext: AccessContext): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as Record<string, unknown>;
  return itemAllowsDocument(record.asset, accessContext) || itemAllowsDocument(record, accessContext);
}

function itemAllowsDocument(item: unknown, accessContext: AccessContext): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === "object"
    ? (record.metadata as Record<string, unknown>)
    : undefined;
  const doc =
    stringValue(record.doc) ??
    stringValue(record.filename) ??
    stringValue(record.document) ??
    stringValue(metadata?.doc) ??
    stringValue(metadata?.filename) ??
    stringValue(metadata?.document);
  if (doc) {
    return documentAllowed(doc, accessContext);
  }
  const source = stringValue(record.source) ?? stringValue(record.title);
  if (source) {
    return documentAllowed(source, accessContext);
  }
  return true;
}

function documentAllowed(documentId: string, accessContext: AccessContext): boolean {
  const allowed = new Set(accessContext.allowedDocumentIds.map(normalizeDocumentId));
  const normalized = normalizeDocumentId(documentId);
  if (allowed.has(normalized)) {
    return true;
  }
  const withoutExtension = normalized.replace(/\.pdf$/, "");
  if (allowed.has(withoutExtension)) {
    return true;
  }
  return [...allowed].some(allowedDocument => {
    const allowedBase = allowedDocument.replace(/\.pdf$/, "");
    return normalized.includes(allowedBase);
  });
}

function isRestricted(accessContext: AccessContext): boolean {
  return accessContext.allowedDocumentIds.length > 0;
}

function normalizeDocumentId(value: string): string {
  return value
    .replace(/^document:/i, "")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
