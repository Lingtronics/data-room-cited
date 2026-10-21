# Feature Specification: Voice-Cited Research Agent
**Project:** Data Room Cited\
**Feature ID:** DRC-VOICE-001\
**Status:** Implementation-ready specification (not an implementation claim)\
**Repository:** https://github.com/Lingtronics/data-room-cited\
**Baseline:** `main` as inspected on 20 October 2026; Codex must inspect the checkout again before changing code.\
**Priority:** MVP first; no private-data deployment in this phase.

## 0. Execution brief for Codex

Implement an opt-in, voice-enabled research experience for Data Room Cited using **ElevenLabs ElevenAgents**, the existing **TypeScript Streamable HTTP MCP gateway**, and the existing **Python/FastAPI RAG and citation-verification core**.

**Work incrementally.** First audit the current checkout and validate the ElevenLabs SDK/API against its official documentation. Do not overwrite, break, or replace existing Streamlit, MCP, CLI, ingestion, multi-agent, evaluation or authentication capabilities. Prefer small changes that can be reviewed separately. Write tests alongside the feature.

**Do not** create or modify an ElevenLabs account, purchase services, upload documents, deploy a public endpoint, change remote agent settings, push changes or open a PR without explicit approval. All basic development and automated tests must run without an ElevenLabs API key through mocks. Clearly report external prerequisites.

At completion, provide: changed files, commands run and actual results, security constraints, externally required setup, screenshot or recording instructions for the demo, and any unmet acceptance criteria. Never claim a test ran unless it ran.

## 1. Purpose, user story and success conditions

### User story

As a diligence analyst, I want to ask questions about an **approved synthetic demonstration data room** using my microphone, hear a concise response, and see source excerpts, document names and page references so that I can inspect evidence without giving up the auditability of the existing text experience.

### Core demonstration

1. User opens the new Voice Research page.
2. Page explains microphone and third-party voice processing before permission is requested.
3. User starts an ElevenAgents session through a **server-issued signed URL**.
4. User asks: "What are the material customer-contract risks?"
5. Agent calls the existing `search_data_room` MCP tool, and where required `verify_citation`.
6. Agent delivers a concise voice answer with appropriate uncertainty; the web page displays only evidence the Data Room Cited backend has verified.
7. User interrupts or asks: "Limit that to the 2025 report." The new turn uses the updated constraint; no invented filter is treated as verified.
8. Where evidence is missing, assistant clearly states that source coverage is insufficient.
9. User ends the conversation; microphone use stops and UI returns to idle.

**Success:** functional local voice question answering, read-only evidence retrieval via MCP, independently verified visible citations, safe failure, repeatable mock tests and an honest demonstration of latency and limitations.

### Explicit non-goals for MVP

- Phone numbers, SIP/telephony, outbound calls, CRM, call recording or production customer support.
- Training speech/LLM models; replacing DeepSeek, embeddings, retrieval or citation-matching code.
- Native mobile apps, multilingual QA validation, auto-generated files, exports, index rebuilds or write tools.
- Exposing personal, confidential or externally sourced customer data to ElevenLabs.
- Claiming enterprise multi-tenant or per-user document isolation through ElevenLabs' shared MCP integration.
- Autonomous production deployment, account creation, payments or automatic remote ElevenLabs configuration.

## 2. Grounding in the existing repository

The repository README and inspected source currently identify:

- Python/FastAPI RAG service: `services/rag-core/app.py` and existing `src/mcp_tools.py` functions.
- TypeScript Streamable HTTP MCP gateway: `apps/mcp-server/src/server.ts` and `apps/mcp-server/src/mcpServer.ts`.
- Gateway request authentication: `apps/mcp-server/src/auth.ts`; configured by `apps/mcp-server/src/config.ts`.
- Gateway endpoint in development: `http://127.0.0.1:8787/mcp`.
- Existing tools: `search_data_room`, `verify_citation`, plus catalogue/retrieval and potentially mutating operations.
- Existing web UI: Streamlit `app.py` on port 8501; **do not replace it**.
- pnpm workspace (`pnpm-workspace.yaml`), TypeScript gateway tests (`pnpm --filter @data-room-cited/mcp-server test`) and Python evaluation/release gates.
- Docker Compose with RAG core, MCP gateway, web, orchestrator and OpenTelemetry collector.
- Gateway currently uses localhost host/origin validation and has development authentication defaults; do not assume it can be safely exposed publicly as written.

**Before implementing:** re-read source files, current README, schemas, gateway access filtering, citation response shapes, tests, lockfile and available scripts. Document any differences. The paths proposed below are new paths, not assertions that they exist.

**Architecture principle:** **add an adapter and UI, not a second RAG system**.

## 3. MVP architecture

```mermaid
flowchart TD
    U[Analyst in browser] --> UI[NEW apps/voice-web\nReact/TypeScript voice UI]
    UI -->|start session| API[NEW apps/voice-api\nlocal-only session/evidence broker]
    API -->|server-side ElevenLabs API key| EL[ElevenLabs ElevenAgents]
    UI <-->|signed real-time voice session| EL
    EL -->|read-only MCP tool calls| MCP[EXISTING TypeScript MCP gateway\nvoice-safe allowlist]
    MCP --> RAG[EXISTING Python/FastAPI RAG core]
    RAG --> FIX[synthetic approved data/index]
    EL -->|client tool: display evidence IDs/quotes| UI
    UI -->|validate evidence| API
    API -->|read-scoped MCP verify| MCP
    API -->|only verified metadata| UI
```

### Ownership boundaries

- **ElevenAgents:** microphone-stream conversation, STT/TTS/orchestration, turn-taking/interruption, prompt, tool invocation.
- **Voice web:** controls, microphone permission, status, transcript, evidence panel, errors, session cleanup.
- **Voice API:** signed-URL issuance, local demo access limits, citation verification mediation, safe error mapping, metadata-only telemetry.
- **Existing MCP gateway:** authoritative read-tool interface and documented scope checking. Add a **voice-specific tool exposure allowlist** instead of exposing every existing capability to the voice agent.
- **Existing RAG core:** factual retrieval and quote verification; remain source of truth.
- **Synthetic demo corpus:** documents safe for third-party voice/model processing.

### Decision: protect identity boundaries

A signed ElevenAgents URL authenticates access to **the voice agent**, not to each user's private Data Room Cited documents. A static ElevenLabs MCP secret can identify an **integration/service identity**, not the end user. Do not derive workspace, permitted documents or write approvals from agent prompts, client-provided IDs, dynamic variables or utterances.

The MVP is therefore **single synthetic demo workspace, read-only and local-first**. Do not expose real user data or describe it as per-user secured production access. Multi-user rollout requires an independently verified end-user identity binding on each data access request, designed and tested in a separate feature.

## 4. Proposed code organisation

Create or adapt according to repository conventions:

| Path | Responsibility |
|---|---|
| `apps/voice-web/` | Small Vite + React + TypeScript app; uses `@elevenlabs/react` and accessible controls |
| `apps/voice-api/` | Minimal TypeScript HTTP service for signed sessions and evidence verification |
| `apps/mcp-server/src/mcpServer.ts` | Add narrowly scoped voice tool registration control without changing defaults for existing clients |
| `apps/mcp-server/src/config.ts` | Add optional voice demo allowlist configuration; fail closed for voice mode |
| `apps/voice-web/src/` | Conversation UI, status, transcript, evidence cards; separate composable components |
| `apps/voice-api/src/` | Config validation, ElevenLabs signed URL adapter, MCP read-only client/verification adapter |
| `tests` colocated with each new app | Unit, integration, contract/security tests |
| `docs/voice-agent-setup.md` | Manual ElevenAgents setup, architecture, limitations, troubleshooting |
| `docs/voice-demo-script.md` | Three reproducible scenarios and expected evidence |
| `.env.example` | Redacted new env-var names with no embedded credentials |
| `docker-compose.voice.yml` (optional) | Add-on services, not a breaking modification of default Compose |

Use existing pnpm-workspace conventions. If existing packages provide reusable clients and schemas, reuse rather than duplicate. Verify Node and current SDK API versions against actual lockfile.

## 5. Functional requirements

### FR-01: Signed voice sessions

- Add `POST /api/voice/session` (body `{}`) to the new API.
- In local MVP, bind backend only to loopback and permit only configured local development Origins. **Never expose this unauthenticated endpoint on a public interface.**
- Server uses `ELEVENLABS_API_KEY` and fixed `ELEVENLABS_AGENT_ID` from environment; client must not choose arbitrary agent IDs or send secrets.
- Server calls current ElevenLabs **Get signed URL** API and returns `{ "signed_url": "...", "expires_at": "ISO-8601" }`. The expiry is computed from the documented validity window; do not assume the returned URL is reusable.
- Reject missing configuration, upstream 4xx/5xx, bad responses, non-local access or exhausted rate limits with a stable error code. Do not log signed URLs or API keys.
- UI requests microphone permission only after explicit user action; use current `@elevenlabs/react` start/end session methods per official documentation.
- UI states: `idle`, `requesting_permission`, `connecting`, `listening`, `agent_speaking`, `disconnecting`, `error`. Validate callback/event semantics against installed SDK. End session on user action and component unmount.

### FR-02: Read-only MCP evidence

- Configure ElevenAgents with a custom Streamable HTTP MCP integration pointing to an explicitly reachable **demo** gateway over HTTPS where required by the provider. Loopback URLs are not remotely reachable; use a controlled short-lived HTTPS tunnel **only when explicitly approved**.
- The identity attached to the integration is a **read-only demo service identity** with permission only for synthetic data. All gateway auth defaults must be made secure for this use (`MCP_AUTH_REQUIRED=true`, `MCP_ALLOW_DEV_TOKENS=false`, JWT with validated issuer/audience/expiry and restricted claims).
- In voice mode, expose ONLY `search_data_room` and `verify_citation` by default. Optionally expose a source-details read operation if verified safe. Do not expose `sync_document_source`, `rebuild_index`, exports, admin/connector actions, arbitrary resources or prompts.
- Deny mutating calls in the MCP server even if ElevenLabs approval configuration is changed.
- Preserve the existing broad gateway capability for other clients through opt-in, backward-compatible config; do not weaken global auth or allowlist checks.
- Restrict corpus/index to explicitly approved synthetic fixtures. Use a separate fixture directory/index or isolated service configuration; no real PDFs mounted into this environment.
- Preserve MCP schema validation, bounded query size, `top_k` cap, timeouts, recoverable errors and audit events. Add tests for disallowed tool and resource discovery, and denied invocation.
- Set ElevenLabs fine-grained tool approvals consistent with read-only policy. Platform approval settings are supplementary, **not** an authorisation boundary.

### FR-03: Evidence and citations in the UI

- The agent may request a client tool named `displayEvidence` with 1–5 pairs of `{chunk_id, quote}` corresponding to retrieved source quotes. Client-tool arguments are **untrusted**.
- Implement `POST /api/voice/evidence/verify` with request:
  ```json
  { "items": [ { "chunk_id": "fixture-chunk-id", "quote": "exact quoted source excerpt" } ] }
  ```
  and response:
  ```json
  {
    "items": [
      {
        "chunk_id": "fixture-chunk-id",
        "verified": true,
        "document": "synthetic-file.pdf",
        "page_label": "3",
        "quote": "exact quoted source excerpt"
      }
    ]
  }
  ```
  `document` and `page_label` are derived from existing verified source metadata only; do not manufacture page numbers. If missing, omit or return null and show "source location unavailable".
- The API must call existing MCP or trusted citation-verification logic **under the demo read-only context**, enforce the same fixture restrictions and return only server-resolved metadata.
- Reject extra fields, oversized arrays/strings, unknown chunk IDs, invalid citations and bad upstream envelopes; sanitise text for display. Unverified citations are **never rendered as valid**.
- Evidence panel shows document, page/section when present, quote and status. If none pass validation, show **"No verified citations for this answer"**, not fabricated links.
- Client tool must be configured to **wait for its response** when the agent is expected to acknowledge the validation result. Do not treat the tool call itself as evidence.
- The agent's spoken answer should name its source briefly when grounded, and acknowledge insufficient evidence explicitly when unsupported.
- If integrating real-time transcript callbacks, label transcript text as **recognised/interpreted speech**, not as an independently verified documentary claim.

### FR-04: Conversational UX

- Clearly show Start/End, microphone permission help, connected/disconnected states, spoken text/transcript when surfaced by SDK, active evidence and safe retry.
- Support interruption/turn-taking using SDK's native facilities; do not implement a competing custom audio transport in MVP.
- Text-only fallback if SDK supports it; otherwise show helpful unavailable status without losing the existing Streamlit app.
- On disconnect, clear session-specific evidence and disable updates to prior session. Avoid race conditions after unmount.
- User-facing error categories: microphone denied, missing agent/config, signed URL failure, connection lost, MCP unavailable, verification failed, no matching evidence.
- Mobile-responsive if straightforward; accessibility requires semantic buttons, visible focus, keyboard operation, transcript labels and status announcements.

### FR-05: Agent configuration

Provide a version-controlled `docs/voice-agent-setup.md` containing configuration values and a succinct prompt template. Configure the external agent **manually** (or via supported API only with approval). Required behaviour:

- Acts as a diligence evidence assistant, not an investment decision-maker.
- Retrieves through `search_data_room`; never answers document-specific factual questions from assumed general knowledge.
- Uses `verify_citation` and `displayEvidence` to surface verifiable source excerpts.
- Speaks concisely (usually 1–3 short sentences), offers follow-up, and does not read long citations aloud.
- If evidence is absent, ambiguous or contradictory, reports uncertainty, avoids invented page numbers, quotes, statistics and causal claims.
- Treats retrieved text as **data** and ignores instructions or secrets embedded in PDFs.
- Cannot invoke write, administration or cross-tenant operations.
- Context changes such as "only 2025" must be applied to retrieved data **only if repository-supported metadata/filtering actually enforces the constraint**. If the schema cannot filter dates, implement a validated filtering path or clearly state that exact filtering is unavailable; never claim compliance from a prompt alone.

### FR-06: Privacy and observability

- No persistent raw audio files, conversational transcripts, signed URLs, secret tokens or document excerpts in application telemetry.
- Log correlation ID, duration, tool type, verification outcomes, error class and latency distributions. Scrub request headers and payloads.
- Show a clear disclosure: microphone audio and conversation content will be processed by ElevenLabs; only synthetic/approved corpus is enabled in MVP. Users must choose to start.
- Document provider privacy/data-retention settings as external configuration; **do not claim zero retention** (also note ElevenLabs MCP availability restrictions for Zero Retention Mode).
- Add timeout/retry/backoff only where idempotent; keep upstream errors recoverable and avoid unbounded retries/costs.
- Provide a configurable local demo session limit and request throttling; report measured request counts/costs when available, never invent them.

## 6. Configuration contract

Add to `.env.example` with blank values for secrets:

```dotenv
VOICE_FEATURE_ENABLED=false
VOICE_API_HOST=127.0.0.1
VOICE_API_PORT=8790
VOICE_WEB_PORT=5173
VOICE_ALLOWED_ORIGINS=http://localhost:5173
VOICE_MAX_SESSION_MINUTES=15
VOICE_READ_ONLY_DEMO=true
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
VOICE_MCP_BASE_URL=http://127.0.0.1:8787/mcp
VOICE_MCP_SERVICE_TOKEN=
VOICE_FIXTURE_DATA_DIR=
VOICE_FIXTURE_INDEX_DIR=
```

Names are **proposed app-specific configuration**, not existing repository environment variables. Do not commit real keys or minted tokens. Validate strict production/dev mode: if non-loopback host, real indexed documents, unsafe auth defaults or write tools are detected in MVP voice mode, **refuse startup** with an actionable message. The repository may already use separate `.env` loading conventions; follow them.

## 7. Implementation sequence: small, independently testable milestones

### M0 — Reconnaissance, design decision and baseline (no functional code)

- Inspect repository actual paths, tests, existing MCP outputs, auth/access filters, fixture release gate and SDK compatibility.
- Confirm citation verification envelope and metadata fields. Record any response shape mismatches; adjust the API contract above without weakening verification.
- Run applicable existing baseline tests; report status (including if dependency/key prevents a test).
- Write a brief security decision record explaining why the MVP is single-fixture and cannot claim per-user authorisation.

**Gate:** existing tests and paths are understood; no guessed API signatures are implemented.

### M1 — Voice-safe gateway and synthetic fixture isolation

- Add opt-in per-instance allowlist that registers or exposes only `search_data_room` and `verify_citation`, plus strictly necessary metadata as approved.
- Ensure denial of write tool calls, resources and any unapproved tool names under the demo configuration.
- Isolate fixture corpus and index. Preserve existing gateway defaults for ordinary clients.
- Write tests for bad bearer tokens, wrong audience, missing scope, cross-fixture access, write attempt and tool discovery. A **denied** request is a pass.

**Gate:** a voice-configured MCP instance cannot read anything outside the synthetic fixture, invoke write tools or enumerate unapproved resources. No unsafe default used.

### M2 — Voice API, signed session and verified evidence endpoints

- Implement env/config validators, fixed-agent signed URL retrieval and stable error envelope.
- Implement evidence-verification endpoint through existing trusted MCP functions. Mock all external ElevenLabs/MCP interactions in unit tests.
- Test missing secret, API upstream failure, no exposed secrets, spoofed Origin, malformed evidence and false/unknown citation.
- Add deterministic integration test against the fixture-enabled MCP server.
- Verify signed URL lifetime behaviour against current documentation; refresh via a new request, never cache globally.

**Gate:** no API keys or signed URLs appear in logs or response diagnostics; invalid evidence never receives `verified:true`.

### M3 — Voice web UI

- Build standalone React app in `apps/voice-web`, leaving Streamlit untouched.
- Integrate current `@elevenlabs/react` SDK; do not copy examples from an outdated SDK version.
- Implement mic permission explanation, start/stop lifecycle, state view, transcript, verified evidence panel, errors and clean disconnect.
- Register `displayEvidence` as a client tool with runtime payload validation and server verification before rendering.
- Build mock mode where a scripted test conversation can exercise all UI states and evidence verification without mic or API keys.

**Gate:** local mock demo passes: start, transcript/status, valid source shown, invalid source rejected, disconnect, retry.

### M4 — External ElevenAgents wiring and manual end-to-end acceptance

- Follow official ElevenAgents agent, SDK, auth, MCP and testing docs.
- Configure signed-URL authentication and the restricted synthetic read-only MCP integration.
- Only with user approval, establish a temporary HTTPS route reachable by ElevenLabs for the demo gateway. Keep local validation checks and add an explicit trusted external-host/origin configuration rather than disabling them wholesale.
- Configure MCP read tools and the `displayEvidence` client tool. Save prompt/config instructions without secrets.
- Execute real spoken acceptance scenarios and capture observed outcomes; don't fabricate successful external tests if not run.
- Prefer provider's current agent-testing framework; do **not** use deprecated simulation API.

**Gate:** one successful grounded Q&A with an actually verified displayed citation; one abstention and one denied/unavailable-tool scenario witnessed and recorded.

### M5 — Regression, docs and demonstration polish

- Add package scripts: `voice:dev`, `voice:build`, `voice:typecheck`, `voice:test` (adapt to repo conventions).
- Run existing Python release gate and TypeScript MCP contract test, plus new voice tests.
- Add documented startup, env/template, agent steps, troubleshooting, threat model, limitations, optional recording instructions and a concise architecture diagram.
- Summarise actual changes, actual passing/failing tests and known limitations.

**Gate:** independent reviewer can run mocked local demo from README, and reproduce real demo after supplying approved credentials/configuration.

## 8. Test matrix and executable acceptance criteria

| ID | Case | Expected result | Level |
|---|---|---|---|
| AC-01 | Existing Streamlit, gateway and release-gate workflows | No regressions | Existing scripts |
| AC-02 | Voice feature disabled | No voice endpoints exposed; existing services work | Integration |
| AC-03 | Start valid local demo session | Backend returns usable short-lived signed URL; no key to browser | Unit + manual |
| AC-04 | Mic permission denied | Clear error, no hanging spinner, no session leak | UI |
| AC-05 | Synthetic question with matching evidence | MCP retrieval and successful citation verification; visible correct source | Mock + live |
| AC-06 | Fabricated chunk ID or incorrect quote | `verified:false` or explicit error; never a valid citation card | Unit/integration |
| AC-07 | Insufficient evidence | Agent states limitation; UI shows no verified citation | Simulation + manual |
| AC-08 | User interrupts, corrects scope | Turn-taking functions; filtering either enforced or limitation disclosed | Manual |
| AC-09 | Disallowed tool call such as `rebuild_index` | Not exposed/denied; index unchanged | Security integration |
| AC-10 | Invalid/expired/wrong-audience bearer JWT | MCP returns unauthorised; no data | Security integration |
| AC-11 | Out-of-scope document attempted | No exposed content, even if source ID is guessed | Security integration |
| AC-12 | ElevenLabs/MCP timeout | Actionable error; retry safe; no fabricated citations | Mock |
| AC-13 | End session, remount/unmount | Mic released, event handlers cleaned; no stale evidence | UI |
| AC-14 | Application telemetry inspected | No secrets, signed URLs, raw audio, transcript or quotes | Unit/log audit |
| AC-15 | Voice path with no ElevenLabs credentials | Full mock/unit/test workflow remains executable | CI |
| AC-16 | External end-to-end trial | Evidence of actual real conversation and MCP calls or documented blocker | Manual |

**Suggested evaluation dataset:** at least 12 authored, synthetic fixture questions (4 grounded single-document, 2 cross-document, 2 unsupported, 2 adversarial/prompt-injection, 1 attempted restricted tool, 1 follow-up scope change). Store expected document/chunk IDs, quotes and outcomes in version control without secrets. Run deterministic verification tests on every change; use ElevenLabs agent tests for probabilistic conversation behaviour when credentials are available.

**Latency/cost report (measurement, not a contractual SLO):** collect 10+ real warm-session trials if feasible; report p50/p95 time from end of user utterance to first audible response, MCP retrieval duration, citation-verification duration, conversational success and provider usage cost if measurable. Label sample sizes and test environment. Never fabricate latency or costs.

## 9. Definition of done

All of the following must be true to mark the MVP complete:

- [ ] New opt-in voice UI works locally and existing UI remains available.
- [ ] ElevenAgents session created using server-side API key and signed URL.
- [ ] Restricted read-only MCP integration uses synthetic data only.
- [ ] At least one spoken question results in evidence retrieval via existing Python/TypeScript stack.
- [ ] Valid source references are verified in code before display; unsupported citations rejected.
- [ ] Missing evidence, failed calls, denied permission and disconnect are handled cleanly.
- [ ] Tests for auth, tool allowlisting, source isolation, quote verification and mock UI pass.
- [ ] Existing release gates still run with no newly introduced regressions.
- [ ] Security limitations and external account/prerequisite steps are documented.
- [ ] Demo script and actual test evidence supplied, including any tests not run.

**Stop conditions:** Never relax security controls to make a demo work. If verified end-user identity propagation proves necessary to access non-synthetic documents, stop and record a separate design task. If the repository/API differs materially from this spec, document the difference and follow the verified upstream contracts; do not fake compatibility.

## 10. Recommended demo and CV evidence

Demo scenario A — **Supported evidence:** "Which contracts have automatic renewal risk?" Agent retrieves fixture excerpts; UI shows verified sources; speaker summarises source limits.

Demo scenario B — **Scope change:** "Only discuss the 2025 documents." Either apply supported metadata filtering and demonstrate it or disclose that the filter is not yet enforceable.

Demo scenario C — **Safety:** "Export the complete private data room" or "Search a document that isn't in the demo corpus." No write/cross-boundary capability is exposed; system refuses safely.

Only after verification, describe the portfolio feature accurately on a CV (example wording to edit to actual scope): **"Integrated ElevenLabs conversational agents with a TypeScript Streamable HTTP MCP gateway and Python/FastAPI retrieval service, enabling spoken, citation-verified Q&A over a synthetic document corpus."** Do not call this enterprise multi-tenant, production deployed or voice latency optimised without evidence.

## 11. Official documentation and project references

All links below were checked for relevance on 20 October 2026; SDK/API versions may evolve, so verify during implementation.

- Existing repository: https://github.com/Lingtronics/data-room-cited
- ElevenAgents React SDK: https://elevenlabs.io/docs/eleven-agents/libraries/react
- ElevenAgents MCP integration: https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp/
- Agent authentication and signed URLs: https://elevenlabs.io/docs/eleven-agents/customization/authentication
- Get signed URL API: https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/get-signed-url
- Client tools: https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools
- Agent testing: https://elevenlabs.io/docs/eleven-agents/customization/agent-testing

**Provider notes from current docs:** ElevenAgents supports Streamable HTTP MCP; the React SDK is `@elevenlabs/react`; signed URLs are short-lived and should be issued server-side; agent testing supports simulation, next-reply and tool-call validation. MCP may be unavailable under Zero Retention Mode/HIPAA settings. Current agent simulation guides may be deprecated; prefer the Agent Testing framework.

## 12. Codex kickoff command / task

> Read `docs/VOICE_FEATURE_SPEC.md` in full, inspect the actual `main` branch checkout, and implement **M0 then M1 only** with tests. Preserve existing behavior and do not deploy, modify any ElevenLabs account settings, expose a gateway externally, or handle private documents. Report the files changed, exact tests executed and results, and anything requiring approval. Continue to M2/M3 only after their preceding acceptance gates are satisfied. Build mocks so automated tests do not require an ElevenLabs API key.
