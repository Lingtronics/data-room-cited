# M0: voice reconnaissance and security decision

Date: 20 October 2026. Baseline: `main` at
`89d4ecde8bb8f76aaa664d230baa8e077e521b20`.

The workspace was empty; the requested repository was cloned without modifying
the remote. `docs/VOICE_FEATURE_SPEC.md` was absent and is now a verbatim copy of
the user-supplied specification. No AGENTS.md was present. M0 changes only these
two documents. The requested implementation scope is M0 and M1 only.

## Verified repository contracts

- Existing paths in the specification are correct. Streamlit `app.py`, Python
  stdio MCP, ingestion, orchestrator, connector and evaluation code remain in use.
- The pnpm workspace contains the gateway only. Lockfile pins MCP server/client/
  node 2.0.0, Zod 4.4.3, jose 6.2.8, TypeScript 7.0.2 and Vitest 4.1.10.
  There is no ElevenLabs or React dependency. Local tools: Node 24.18.0,
  pnpm 11.25.0 (packageManager requests 11.9.0), Python 3.12.
- MCP results contain both JSON text and `structuredContent` with
  `{ok, correlation_id, data}` or `{ok:false, correlation_id, error:{code,message}}`.
  An HTTP 200/MCP success envelope alone does not mean a citation verified.
- Search data contains `query`, `top_k`, `mode`, `results`; each result has
  `chunk_id`, `doc`, `page`, `page_start`, `page_end`, `section_title`, `source`,
  `score`, `text`. Text is capped at 5,000 characters.
- Verification data contains `verified`, `reason`, `chunk_id`, `quote`, and,
  for known chunks, a formatted `source`. It does **not** provide separate
  document/page fields. M1 may enrich this only in fixture mode using trusted
  chunk metadata; M2 must never parse arbitrary client labels into page numbers.
- Quote verification is case-sensitive substring matching after whitespace
  normalization. It verifies quotation occurrence, not truth or claim support.
- Search supports query/top_k/semantic, not a year filter. Exact year filtering
  cannot be promised. The existing synthetic contract test uses lexical search
  with zero embeddings and does not download models or call an LLM.
- Ordinary gateway registers eight tools, four resources/templates and three
  prompts. Write scopes and approval grants are enforced on write calls.
- Default auth is development-friendly. JWT issuer is optional and expiry is
  only enforced when present. Empty document claims mean unrestricted access.
  Existing post-response filters use fuzzy filename matching and do not filter
  verification results. Python retrieval/verification do not enforce the forwarded
  document headers. Thus existing filtering is not a voice isolation boundary.
- Gateway validates localhost Host/Origin but `listen(port)` binds all interfaces.
  The RAG client has no fetch timeout. Voice mode needs explicit loopback binding,
  bounded inputs/timeouts and a startup check of the upstream fixture profile.

## Official provider contracts checked

Read the official documentation on 20 October 2026; no external account/API calls
were made and no SDK was added in M0:

- [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react): current
  documentation requires ConversationProvider, exposes granular hooks and
  startSession/endSession. M3 must pin a release and check installed types and
  callback semantics before implementation; old hook examples are insufficient.
- [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication):
  signed WebSocket URLs must be used to start within 15 minutes; this is not a
  maximum conversation duration.
- [Signed URL API](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url):
  GET `/v1/convai/conversation/get-signed-url`, agent_id query, server xi-api-key,
  response signed_url; optional include_conversation_id makes the signature
  single-use. M2 must recheck this contract and avoid global URL caching.
- [MCP](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp/):
  Streamable HTTP supported; platform approvals supplement server authorization.
  MCP unavailable with Zero Retention Mode/HIPAA. No zero-retention claim.

## Decision: single immutable synthetic fixture

A signed voice URL authenticates a voice agent, and an MCP service token identifies
an integration. Neither proves an end user's entitlement to a private document.
M1 therefore uses a dedicated fixture process/index and fixed workspace, with
exact document/chunk membership, mandatory issuer/audience/expiry, no development
tokens, no write claims and no resources/prompts. The only registered tools are
search_data_room and verify_citation. Ordinary instances keep their defaults.

The fixture is authored public test data checked against a version-controlled
manifest, not arbitrary files labelled synthetic by a request. Both services
validate it and fail closed on unexpected files, modified bytes or unsafe
configuration. The gateway refuses an ordinary/non-fixture RAG core. Python
voice mode blocks all other routes and enforces the same fixture restrictions.
Lexical retrieval reuses the existing Python implementation; zero embeddings
are never presented as semantic retrieval. No second RAG implementation.

Trusted local code/configuration and the OS account remain the trust boundary.
This is not protection against an administrator replacing code, keys or processes,
and is not per-user or production multi-tenant authorization. External hosting,
tunnels, account changes, pushes and deployments remain outside this work.

## Baseline commands and actual results

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed, lockfile unchanged; required host execution after sandbox symlink failure |
| `python -m venv --system-site-packages .venv` then `.venv/Scripts/python.exe -m pip install -r requirements.txt` | Passed; dependencies installed locally; existing global packages reused |
| `.venv/Scripts/python.exe -m pytest -q --basetemp=.pytest_cache/m0-baseline` | **10 passed**, 1.35s |
| `pnpm --filter @data-room-cited/mcp-server test` | **13 passed**, two files, 3.22s, including real local Python contract fixture |
| `pnpm --filter @data-room-cited/mcp-server build` | Passed |
| `.venv/Scripts/python.exe scripts/evaluate_release_gate.py --fixture --mcp-contract-passed` | **16/16**, release_gate_passed=true |
| `.venv/Scripts/python.exe -m compileall -q services src scripts app.py` | Passed |

Initial system-Python collection failed for missing OpenTelemetry, resolved by
local dependency installation. Shared pytest temp permissions caused four setup
errors; a project-local basetemp resolved them. Sandboxed Vitest temp renames
failed before collecting tests; host execution passed. A sandboxed Python run
stalled after six tests and was interrupted; the host run above passed all ten.
These are environment failures, not reported as passing test runs.

M0 gate: satisfied. Paths, baseline, response shapes and SDK contracts understood;
no functional code added. Next: implement M1's fixture guard, restricted gateway
and negative security tests. M2/M3 and live speech acceptance remain future work.
