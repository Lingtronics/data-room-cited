from __future__ import annotations

import hashlib
import os
from contextlib import contextmanager
from typing import Any, Iterator

from opentelemetry import propagate, trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode


_CONFIGURED = False


def setup_telemetry(service_name: str) -> None:
    """Configure OpenTelemetry when the SDK is available.

    Raw document text is deliberately not attached to spans. Callers should pass
    identifiers, counts, hashes, and controlled metadata only.
    """

    global _CONFIGURED
    if _CONFIGURED or _otel_disabled():
        return
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
    except Exception:
        _CONFIGURED = True
        return

    resource = Resource.create({"service.name": os.getenv("OTEL_SERVICE_NAME", service_name)})
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    traces_exporter = os.getenv("OTEL_TRACES_EXPORTER", "").strip().lower()
    if not endpoint and traces_exporter != "console":
        _CONFIGURED = True
        return

    provider = TracerProvider(resource=resource)
    if endpoint:
        exporter = OTLPSpanExporter(endpoint=_trace_endpoint(endpoint))
    else:
        exporter = ConsoleSpanExporter()
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _CONFIGURED = True


def tracer(name: str = "data-room-cited") -> trace.Tracer:
    return trace.get_tracer(name)


@contextmanager
def span(
    name: str,
    attributes: dict[str, Any] | None = None,
    *,
    kind: SpanKind = SpanKind.INTERNAL,
    context_headers: dict[str, str] | None = None,
) -> Iterator[Span]:
    ctx = propagate.extract(context_headers or {}) if context_headers else None
    with tracer().start_as_current_span(
        name,
        context=ctx,
        kind=kind,
        attributes=safe_attributes(attributes or {}),
    ) as active_span:
        try:
            yield active_span
        except Exception as exc:
            active_span.record_exception(exc)
            active_span.set_status(Status(StatusCode.ERROR, str(exc)))
            raise


def safe_attributes(attributes: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, (str, bool, int, float)):
            output[key] = value[:500] if isinstance(value, str) else value
        elif isinstance(value, (list, tuple)):
            output[key] = [str(item)[:120] for item in value]
        else:
            output[key] = str(value)[:500]
    return output


def identifier_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _trace_endpoint(endpoint: str) -> str:
    cleaned = endpoint.rstrip("/")
    if cleaned.endswith("/v1/traces"):
        return cleaned
    return f"{cleaned}/v1/traces"


def _otel_disabled() -> bool:
    return os.getenv("OTEL_SDK_DISABLED", "").strip().lower() in {"1", "true", "yes", "on"}
