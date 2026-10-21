# M2 delivery report

Date: 20 October 2026. Uses the satisfied [M1 gate](voice-m1-report.md) and the
architecture in [VOICE_FEATURE_SPEC.md](VOICE_FEATURE_SPEC.md). M2 is complete;
M3 was not started. Changes are local and uncommitted. Nothing was deployed,
pushed, exposed publicly or changed in an ElevenLabs account.

## Result and acceptance gate

M2 gate **satisfied** by automated tests: API keys, service tokens, signed URLs
and source excerpts do not appear in logs or failure diagnostics; invalid evidence
never receives verified=true. A signed URL is returned only as the intentional
successful session response, with no-store headers.

- A new opt-in TypeScript API provides POST /api/voice/session and
  POST /api/voice/evidence/verify. Disabled mode does not listen. Enabled mode binds
  only 127.0.0.1 and requires an exact configured local Origin, direct local peer
  and matching Host; forwarded headers are rejected.
- Session requests accept only an empty object and use a server-held API key and
  fixed agent ID. The adapter validates provider URLs, uses a documented single-use
  signature option, calculates a conservative 15-minute start deadline, never
  caches URLs globally and does not retry issuance. Provider calls were mocked.
- Evidence requests accept only 1–5 bounded chunk/quote pairs. The official pinned
  MCP SDK client authenticates to the M1 gateway and calls verify_citation. Both
  signed document claims and the pinned fixture constrain access. A true result
  requires authoritative MCP verification plus matching approved source metadata
  and quote text. False results omit quote/metadata; unknown IDs and malformed
  envelopes fail closed, without partial successes.
- Shared VoicePolicy is exported from the existing MCP package rather than copied.
  Gateway health identifies the synthetic read-only profile and checks the core
  and local fixture on each health request. The API checks this profile, JWT-backed
  authentication and exact two-tool discovery before listening and on each session
  or evidence operation. Resource/prompt capabilities and extra tools are refused.
- Requests and upstream responses are bounded, with deadlines and no redirects.
  Global request throttling and a process-wide session-attempt cap apply before
  asynchronous work, including concurrent or failed issuance attempts. Errors
  contain fixed messages and generated correlation IDs; audit events contain
  route/status/time/error codes and evidence counts only.
- The deterministic integration test starts temporary loopback Python/MCP/API
  services, uses a random test JWT key and synthetic fixture copies, exercises the
  real SDK transport, and mocks only ElevenLabs. It verifies signature/issuer
  rejection, document restrictions, good/bad citations, fixture drift, session
  gating, unchanged index and sanitized diagnostics, then stops all test services.

## Files changed in M2

Earlier M0/M1 work remains in the working tree. This inventory describes only
the files added or updated for M2.

| Added files | Purpose |
|---|---|
| apps/voice-api/package.json, tsconfig.json, vitest.config.ts | New pnpm workspace package, pinned dependencies, strict TypeScript and test configuration |
| apps/voice-api/src/config.ts | Opt-in local configuration, fixed agent, fixture policy and limits |
| apps/voice-api/src/errors.ts, schemas.ts | Stable error mapping and strict bounded request/upstream schemas |
| apps/voice-api/src/elevenLabs.ts, httpClient.ts | Fixed provider endpoint, single-use URL issuance and bounded response reader |
| apps/voice-api/src/mcpEvidence.ts | Authenticated read-only MCP client and trusted evidence projection |
| apps/voice-api/src/limits.ts | Global request window and atomic issuance-attempt reservation |
| apps/voice-api/src/app.ts, server.ts | Local HTTP handling, startup gate, metadata-only auditing and shutdown |
| apps/voice-api/src/config.test.ts, elevenLabs.test.ts, httpClient.test.ts | Configuration, quota, provider and response-stream tests |
| apps/voice-api/src/app.test.ts, mcpEvidence.test.ts | HTTP boundary, mocked MCP, evidence, diagnostics and concurrency tests |
| apps/voice-api/src/integration.test.ts, server.test.ts, testSupport.ts | Actual M1 integration, executable startup tests and synthetic test helpers |
| docs/voice-m2-report.md | This acceptance/result record |

| Modified files | Purpose |
|---|---|
| apps/mcp-server/package.json, tsconfig.json | Export the existing voice policy with declarations |
| apps/mcp-server/src/server.ts | Voice-only health profile and ongoing fixture/core validation; ordinary health behavior retained |
| package.json | voice:build, voice:dev, voice:test and voice:typecheck scripts; existing scripts retained |
| pnpm-lock.yaml | Add the voice-api importer; existing package resolutions unchanged |
| .github/workflows/ci.yml | Build, credential-free tests, lint and typecheck for voice-api in the Node job |
| .env.example | Local API settings, request/session limits, timeout and blank provider/token values |
| README.md | Updated implementation status and test/documentation entry points |
| docs/voice-agent-setup.md, docs/voice-demo-script.md | API startup/contracts, documented provider semantics, limits and mock demonstration |

No Python, Streamlit, orchestrator, ingestion, connector, evaluation implementation,
synthetic corpus, Compose or Dockerfile changes were made in M2.

## Actual verification results

Environment: Windows, Node 24.18.0, pnpm 11.25.0 and Python 3.12 in the local .venv.
All automated tests used mocks or synthetic local services without external
credentials. Tests generated their own temporary authentication keys.

| Command | Actual result |
|---|---|
| pnpm voice:test | **139 passed**, 7 files, 4.54s test-run duration; builds both MCP and voice-api successfully first |
| pnpm --filter @data-room-cited/mcp-server test | **85 passed**, 4 files, 5.28s |
| .venv/Scripts/python.exe -m pytest -q --basetemp=.pytest_cache/m2-delivery | **42 passed**, 4.93s, no skips |
| pnpm -r lint | Passed for MCP and voice-api (TypeScript noEmit checks) |
| pnpm -r typecheck | Passed for MCP and voice-api |
| .venv/Scripts/python.exe scripts/evaluate_release_gate.py --fixture --mcp-contract-passed | **16/16**, all seven release gates passed |
| .venv/Scripts/python.exe -m compileall -q services src scripts app.py | Passed |
| git diff --check | Passed |

Intermediate issues resolved: initial offline dependency resolution lacked cached
registry metadata; prefer-offline installation reused all 143 packages and
downloaded none. A sandbox filesystem denial interrupted an initial automatic
install, then the authorized install completed. TypeScript caught SDK option and
exact-optional-property types, followed by a test helper's inferred Buffer type;
all were corrected. There were no failing runtime acceptance tests in the final
suite. The suite expanded from 125 to 132, 136 and finally 139 passing cases as
integration, stream-boundary and executable-startup coverage was added.

## Unresolved issues and next step

No known failing M2 acceptance case remains. These limits are deliberately open:

- Live signed-URL usability and a spoken conversation were **not tested**. The
  provider contract was checked against official documentation, and requests and
  responses were tested with mocks. No real provider usage/cost/latency is claimed.
- The API is a local single-workspace synthetic demonstration, not end-user
  authentication or private-data isolation. Local OS administrators and trusted
  repository/configuration files remain inside the trust boundary.
- Session/request budgets are in memory and reset on process restart. The session
  cap counts issuance attempts, not concurrent conversations or provider spending.
  The documented 15-minute signed-URL lifetime limits connection start, not call
  duration. VOICE_MAX_SESSION_MINUTES remains for later browser/provider lifecycle
  enforcement; M2 cannot terminate an established browser-to-provider connection.
- No voice UI, microphone lifecycle, external MCP reachability or provider account
  integration exists yet. Exact date filtering and PDF page labels remain
  unavailable for the lexical text fixture, as documented in M1.
- Linux/Node 22 CI, container builds and a manual Streamlit browser session were
  not run locally. CI configuration was updated, but no remote CI run is claimed.

Recommended next implementation: **M3**, the standalone React voice UI with
credential-free mock conversation, explicit microphone consent/lifecycle, verified
evidence rendering, error states and cleanup tests. Keep this API and the existing
Streamlit app intact. External wiring or account changes belong to approved M4
work; deployment remains outside the completed scope.

## Provider references checked for M2

- [Get signed URL](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url):
  fixed GET endpoint, xi-api-key header, agent_id and include_conversation_id=true.
- [Agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication):
  signed URL valid for 15 minutes to initiate a connection; an established session
  can continue beyond that window. A fresh request obtains a fresh URL.
