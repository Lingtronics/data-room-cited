# M1 delivery report

Date: 20 October 2026. Preceded by the satisfied [M0 gate](voice-m0-decision.md).
Scope completed: M0 then M1 only. All changes are local and uncommitted; nothing
was pushed, deployed, exposed publicly or configured in an ElevenLabs account.

## Result and acceptance gate

M1 gate **satisfied** for the implemented synthetic local profile:

- Exactly search_data_room and verify_citation are registered. Resource/template
  and prompt discovery, direct reads and all other tool names are denied.
- Auth requires issuer, audience, expiry, subject, fixed workspace, reader role and
  nonempty exact document claims. Bad bearer, wrong issuer/audience, absent expiry,
  expired tokens, other workspaces/documents, write/admin scopes and approval grants
  are rejected. Each tool still requires its own read scope.
- The approved corpus is three authored synthetic text documents. Both services
  validate exact file sets, sizes and SHA-256 hashes; links and ordinary data/index
  directories are refused. Python loads the validated bytes as a snapshot. The
  gateway checks the upstream profile before binding and on calls, and projects
  output onto approved source fields. Fixture drift fails closed after startup.
- The gateway binds 127.0.0.1 in voice mode and retains Host/Origin checks. The
  dedicated core launcher also binds 127.0.0.1. Its profile denies direct write,
  catalogue, chunk, API documentation and connector routes.
- Existing Python search and quote-verification functions remain authoritative.
  Lexical mode uses a deterministic zero-embedding fixture. Verified text-source
  metadata contains section titles and page_label=null; placeholder page values
  are not returned. Invalid quotes never receive verified=true.
- Queries, top_k, quotes and upstream responses are bounded. Voice fetches time
  out after five seconds with no redirects/retries. Upstream diagnostics are
  sanitized before telemetry and responses; tests check process logs for tokens,
  questions and excerpts. No new external SDK dependency or lockfile change.

## Files changed

M0 added `docs/VOICE_FEATURE_SPEC.md` (verbatim supplied specification) and
`docs/voice-m0-decision.md` (audit, provider contracts, baseline and security ADR).

M1 modified:

| Files | Purpose |
|---|---|
| `apps/mcp-server/src/config.ts`, `auth.ts` | Opt-in validated voice configuration and strict JWT claims |
| `apps/mcp-server/src/mcpServer.ts`, `schemas.ts` | Two-tool registration boundary and strict bounded inputs |
| `apps/mcp-server/src/ragCoreClient.ts`, `server.ts` | Loopback startup/profile checks, timeouts, response bounds, sanitized failures |
| `services/rag-core/app.py`, `src/index_store.py` | Install optional read-only HTTP profile and load verified fixture snapshots |
| `.env.example`, `.gitignore`, `README.md` | Configuration contract, ignored runtime copies and documentation entry point |

M1 added:

| Files | Purpose |
|---|---|
| `apps/mcp-server/src/voicePolicy.ts` | Exact source membership, fixture checks, response projection and verification checks |
| `apps/mcp-server/src/voicePolicy.test.ts` | Configuration/JWT/fixture/input/response/error unit and mock tests |
| `apps/mcp-server/src/voiceGateway.contract.test.ts` | Real loopback HTTP MCP-to-Python acceptance/security tests |
| `src/voice_fixture.py`, `src/voice_core.py` | Approved fixture validation/preparation and read-only adapter around existing mcp_tools |
| `scripts/prepare_voice_fixture.py`, `scripts/run_voice_core.py` | Exclusive fixture copy and safe local core launcher |
| `tests/test_voice_fixture.py` | Python fixture, profile, metadata, isolation, input and failure tests |
| `fixtures/voice/data/synthetic_contracts_2025.txt` | Authored renewal/termination example |
| `fixtures/voice/data/synthetic_risk_review_2025.txt` | Authored evidence-gap example |
| `fixtures/voice/data/synthetic_notes_2024.txt` | Authored older source and adversarial-content example |
| `fixtures/voice/index/chunks.json`, `fixtures/voice/index/embeddings.npy` | Deterministic lexical index |
| `fixtures/voice/manifest.json`, `fixtures/voice/README.md`, `.gitattributes` | Approved-byte manifest, provenance/limitations and stable checkout bytes |
| `docs/voice-agent-setup.md`, `docs/voice-demo-script.md`, `docs/voice-m1-report.md` | Local startup, security boundary, demonstration and actual result record |

The original Streamlit app, orchestrator, Python stdio MCP, ingestion/connector
implementations, evaluation definitions, requirements, package scripts, Compose
configuration and pnpm lockfile were not edited.

## Commands actually run and final results

Environment: Windows, Python 3.12 in local .venv reusing system packages, Node
24.18.0, pnpm 11.25.0. Tests use no ElevenLabs/DeepSeek keys. The Python S3 tests
use the existing fake connector; voice upstream failures use mocked responses.

| Command | Final result |
|---|---|
| `pnpm --filter @data-room-cited/mcp-server test` | **85 passed**, 4 files, 5.49s (13 existing + 72 new) |
| `.venv/Scripts/python.exe -m pytest -q --basetemp=.pytest_cache/m1-delivery` | **42 passed**, 3.42s (10 existing + 32 new), no skips |
| `pnpm lint` | Passed (repository TypeScript noEmit check) |
| `pnpm typecheck` | Passed |
| `pnpm --filter @data-room-cited/mcp-server build` | Passed |
| `.venv/Scripts/python.exe scripts/evaluate_release_gate.py --fixture --mcp-contract-passed` | **16/16**, all seven gates passed |
| `.venv/Scripts/python.exe -m compileall -q services src scripts app.py` | Passed |
| `.venv/Scripts/python.exe scripts/prepare_voice_fixture.py` | Passed; created ignored .voice-demo copy, no services started |
| `git diff --check` | Passed |

Test subprocesses were stopped by awaited teardown. The extra host process-list
inspection was unavailable due to CIM permissions; it is not counted as a passing
check. No persistent test services were intentionally launched.

Intermediate findings: the first TypeScript build caught an inferred callback
type issue (fixed with the existing Zod input type). First expanded suite: Python
41 passed; TypeScript 65 passed/19 failed because the test client assumed JSON
for legacy-compatible SSE responses and fetch rewrote a forged Host. The harness
now reads the actual SSE wire response and uses node:http for the Host test;
all subsequent cases pass. Final additions verify trusted metadata projection,
expiry rechecking and oversized input rejection. Sandbox/temp permission issues
and resolved baseline failures are recorded separately in M0.

## Unresolved issues, external prerequisites and next step

No known failing M1 acceptance case remains. Practical limits are explicit:

- Only this version-controlled synthetic corpus is approved. Real/private data
  and independent end-user authorization are not implemented or tested.
- Fixture retrieval is lexical only. Date filtering is unavailable and invented
  filter fields are rejected. Text sources do not supply PDF page labels.
- No signed-session/evidence API, microphone UI, speech trial, provider account
  configuration, HTTPS tunnel or deployment exists. Full MVP AC-03–08, AC-12–13
  and AC-16 require later milestones; M1 is not the full voice MVP.
- External JWKS provider integration, container builds, Linux execution and a
  live Streamlit browser session were not run. Existing automated regression
  suites and compilation pass; no broader manual coverage is claimed.
- Local code, manifest, keys and OS administration remain trusted. The internal
  core's headers are not independent per-user identity; see the M0 decision.

Recommended next implementation: **M2**, the local-only signed-session broker and
strict evidence-verification API, tested with mocked ElevenLabs and this fixture
gateway. Recheck official signed-URL semantics, keep fixed agent selection on the
server, and expose no secrets in logs. M2 was not started because the user's scope
for this request is M0 and M1. Provider settings, external reachability and any
deployment still require separate approval.
