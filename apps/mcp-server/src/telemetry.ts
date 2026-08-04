import { context, propagation, SpanStatusCode, trace, type SpanAttributes } from "@opentelemetry/api";

const tracer = trace.getTracer("data-room-cited.mcp-server");

export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: safeAttributes(attributes) }, async span => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

function safeAttributes(attributes: SpanAttributes): SpanAttributes {
  const output: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map(item => String(item).slice(0, 120));
    } else if (typeof value === "string") {
      output[key] = value.slice(0, 500);
    } else {
      output[key] = value;
    }
  }
  return output;
}
