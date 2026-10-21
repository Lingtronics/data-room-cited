# M1–M3 local evidence and UI demonstration

Run the automated commands in [voice-agent-setup.md](voice-agent-setup.md). The
HTTP security contract test is the repeatable demonstration for this milestone.
It runs over the existing TypeScript gateway and Python FastAPI/mcp_tools path.

| Scenario | Local MCP action | Expected result |
|---|---|---|
| Supported evidence | search_data_room query="automatic renewal", then verify_citation with a returned chunk_id and exact excerpt | Approved synthetic source; verified=true only for matching quotes; section title, page_label=null |
| Unsupported evidence | verify voice-contracts-2025-1 with "invented revenue" | verified=false; no valid citation metadata |
| Scope correction | Search with extra year=2025 | Invalid arguments. Exact year filtering is unavailable; do not claim the spoken correction was enforced |
| Access isolation | Token restricted to synthetic_contracts_2025.txt; search "Birch pilot" or verify voice-notes-2024-1 | No results / forbidden_document |
| Write attempt | rebuild_index, sync_document_source or export_powerpoint_outline | Unregistered/denied, fixture index unchanged |
| Injection source | Search "Ignore previous instructions" | Synthetic 2024 source is data; no export capability exists |

For a local evidence recording, capture the passing test totals, two-tool discovery
and a synthetic search/verification result. Exclude environment values, JWTs and
headers from the capture. There is no voice UI screenshot or spoken session to
record in M1; label the recording "synthetic read-only MCP foundation". Live speech,
latency percentiles and provider costs have not been measured.

## M2 credential-free API demonstration

Run `pnpm voice:test`. It builds the shared policy and API, then executes mocked
unit/security tests and `apps/voice-api/src/integration.test.ts`. That integration
starts temporary fixture-only Python/MCP/API servers bound to 127.0.0.1, generates
a random signing key and short-lived token, and injects a fake ElevenLabs response.
It does not issue a live signed URL or incur provider usage.

| Scenario | Expected API result |
|---|---|
| Valid quote plus fabricated quote | First item has verified=true and approved document/section; second has verified=false without quote/metadata |
| Guessed private chunk or caller-supplied verified/document fields | 403 or 400, never a valid citation |
| Narrow document token | Matching fixture works; an excluded chunk is denied |
| Wrong JWT signature or issuer | Startup fails before listening |
| Session request | Safe gateway checked first; mock URL and conservative expiry returned, no key |
| Fixture changes while services run | Evidence and session requests fail closed; no provider call |
| Logs and source index inspected | No credentials/URLs/excerpts in diagnostics; index unchanged |

The unit suite also covers provider timeouts/4xx/5xx/malformed responses, missing
secrets, forged MCP envelopes, unsafe capabilities, Origin/Host spoofing, oversized
and chunked bodies, request throttling and concurrent issuance caps. Record the
actual passing totals from the runner. Label any recording "local voice API with
mocked provider". M2 did not include a microphone UI or spoken acceptance run.

## M3 scripted UI demonstration

Run `pnpm voice:mock` and open `http://127.0.0.1:5173`. No API, Python process,
microphone, external credentials or provider connection is needed for this screen.
The page labels the conversation and verification as simulated. It is a UI test,
not a live retrieval or speech-quality demonstration.

1. Select **Supported claim + rejected citation**. Choose **Start mock demo**.
   Observe Connecting, the scripted user/assistant transcript, Checking the sources,
   Assistant speaking and Demo ready. The approved Alder renewal excerpt appears
   under synthetic_contracts_2025.txt, section Synthetic contracts, 2025. There is
   no PDF page number. The fabricated second quote is withheld; only one card appears.
2. Choose **End conversation**. Transcript and evidence clear and Start returns.
   Select **Insufficient evidence** and start again. The transcript acknowledges
   insufficient support and the panel says **No verified citations for this answer**.
3. End, select **Evidence service unavailable** and restart. An actionable error
   appears and no valid source card remains. End and restart the supported scenario
   to demonstrate recovery. In text-only mode, sending a follow-up produces a clearly
   scripted reply and discloses that exact year filtering is unavailable.

For screenshots or a short recording, capture the full page including MOCK DEMO
and SYNTHETIC DATA ONLY labels. Capture supported evidence after the source check,
then an unsupported/unavailable state and the cleared screen after End. At 390 px
width the evidence panel stacks below the conversation. Do not crop out the mock
disclosure or describe the animation as measured audio activity. No audio is played.
Exclude terminals, environment values, browser network panels and real documents.

`pnpm voice:test:e2e` automates these flows and saves synthetic desktop/mobile PNGs
in apps/voice-web/test-results. It additionally runs the real installed React SDK
against mocked HTTP/WebSocket services, verifies fake microphone track cleanup,
and rejects unsafe development-server requests. All browser audio is fake; no
real ElevenLabs conversation, timing or cost is claimed. See the
[M3 report](voice-m3-report.md) for actual test totals and remaining M4 work.

## M4 live acceptance (not run)

Follow the three witnessed trials in the [M4 approval package](voice-m4-approval.md)
only after approving software installation, the temporary route and sandbox
configuration. The [twelve synthetic cases](../evals/voice_m4_cases.json) provide
questions and expected evidence for later provider tests. Local contract tests
verify their source excerpts through Python/MCP; they do not test an agent's
spoken answers. All [live results](voice-m4/acceptance-results.json) remain not_run.
