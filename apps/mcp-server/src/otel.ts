import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | undefined;

export function setupTelemetry(serviceName: string): void {
  if (sdk || otelDisabled()) {
    return;
  }

  const endpoint = traceEndpoint(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );
  if (!endpoint) {
    return;
  }

  if (debugEnabled()) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
  });

  sdk.start();
  process.once("SIGTERM", shutdownTelemetry);
  process.once("SIGINT", shutdownTelemetry);
}

async function shutdownTelemetry(): Promise<void> {
  const activeSdk = sdk;
  sdk = undefined;
  if (activeSdk) {
    await activeSdk.shutdown();
  }
}

function traceEndpoint(endpoint: string | undefined): string | undefined {
  const cleaned = endpoint?.trim().replace(/\/+$/, "");
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.endsWith("/v1/traces")) {
    return cleaned;
  }
  return `${cleaned}/v1/traces`;
}

function otelDisabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase(),
  );
}

function debugEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.OTEL_DEBUG ?? "").trim().toLowerCase(),
  );
}
