# M3 delivery report

Date: 20 October 2026. M3 uses the existing [M2 API](voice-m2-report.md) and the
[feature specification](VOICE_FEATURE_SPEC.md). The **M3 mock-demo acceptance gate
is satisfied**. M4 live acceptance is not claimed. All changes remain local and
uncommitted; no deployment, public endpoint, tunnel, provider call, account change
or remote agent configuration was performed.

## Result and acceptance evidence

The new standalone React UI includes explicit microphone/provider disclosure,
Start/End, seven lifecycle states, bounded in-memory transcript, verified evidence,
safe errors/retry, text-only mode and a responsive layout. Streamlit remains intact.
The real SDK integration uses the installed @elevenlabs/react 1.19.0 API and M2
signed sessions. Mock mode is a labelled canned simulation using approved synthetic
excerpts, with no microphone, API request or provider SDK loading.

| M3 gate | Observed result |
|---|---|
| Start | Keyboard-triggered Start enters the scripted conversation; live-mode SDK connects over a mocked WebSocket |
| Transcript/status | Scripted and actual SDK message callbacks update labelled transcript/status |
| Valid source | Only a successful verification response produces a source card with the approved document, section and exact excerpt |
| Invalid source | Fabricated quote withheld; malformed payloads/responses, stale results and failed checks cannot produce a verified card |
| Disconnect | End clears transcript/evidence; actual SDK fake microphone tracks all reach ended |
| Retry | End/restart works; permission denial is recoverable; uncertain cleanup blocks restart and instructs closing the tab |

The browser registers only displayEvidence and waits for the M2 verification
result before returning counts or a safe error to the agent. Shared runtime schemas
reject additional authority/metadata fields. Rendering uses text nodes. New turns,
interruptions, disconnect, cancellation and unmount invalidate old evidence and
callbacks. Backend read-only policy, token validation and fixture restrictions remain
authoritative. The UI never receives API keys or MCP service tokens and denies
unexpected interactive MCP tool approval requests.

## Files changed for M3

Paths below are relative to the repository. Earlier uncommitted M0–M2 changes are
still present and are not attributed to M3.

| Files | Purpose |
|---|---|
| apps/voice-web/package.json, tsconfig.json, index.html, vite.config.ts | New React/Vite app, strict application types, explicit public config, loopback-only serving |
| apps/voice-web/sdkPrivacy.ts | Scoped suppression of raw SDK diagnostics; no global console replacement |
| apps/voice-web/src/main.tsx, LiveApp.tsx, MockApp.tsx | Disabled/local gate, lazy SDK or mock entry, provider lifecycle |
| apps/voice-web/src/Workspace.tsx, Transcript.tsx, EvidencePanel.tsx, styles.css | Accessible controls, disclosure, status/transcript, evidence cards and responsive presentation |
| apps/voice-web/src/config.ts, errors.ts, api.ts | Public setting validation, fixed error messages and bounded M2 HTTP client |
| apps/voice-web/src/conversation.ts, sdkDriver.ts, mock.ts | Session controller, callback-based SDK adapter and synthetic scripted demo |
| apps/voice-web/src/config.test.ts, api.test.ts, conversation.test.ts, sdkDriver.test.ts, Workspace.test.tsx, mock.test.ts | 92 unit/component cases, including fixture provenance and privacy |
| apps/voice-web/src/testHelpers.ts, testSetup.ts, vitest.config.ts | Credential-free test fixtures and isolated component cleanup |
| apps/voice-web/e2e/voice.spec.ts, playwright.config.ts | Eight browser tests, mocked HTTP/WebSocket and fake microphone devices |
| apps/voice-api/src/schemas.ts, package.json, tsconfig.json | Browser-safe shared response schema export and declaration output; M2 routes unchanged |
| package.json, pnpm-lock.yaml | Voice build/dev/mock/test commands and pinned UI dependencies |
| .github/workflows/ci.yml, .gitignore, .env.example | Credential-free UI/browser CI steps, ignored browser output and public config examples |
| README.md, docs/voice-agent-setup.md, docs/voice-demo-script.md | Reproducible mock startup, contracts, security limits and recording instructions |
| docs/voice-m3-report.md, docs/images/voice-m3-desktop.png, docs/images/voice-m3-mobile.png | This report and inspected synthetic mock screenshots |

No M3 edits were made to Python/FastAPI RAG, MCP authorization/implementation,
Streamlit, ingestion, evaluation code, synthetic fixtures, Compose or Dockerfiles.
The workspace configuration has no semantic change or new dependency-age exception.

## Actual verification results

Environment: Windows, Node 24.18.0, pnpm 11.25.0, Python 3.12.4 and installed Chrome.
All tests ran without external credentials. M2/MCP contracts used generated test
JWTs and temporary synthetic loopback services. Browser HTTP/WebSocket provider
responses and audio devices were mocked. No real microphone or provider was used.

| Command | Final observed result |
|---|---|
| pnpm install --frozen-lockfile --offline | Passed from local cache; lockfile current |
| pnpm voice:test | MCP/API/UI builds passed; **API 139 passed** in 7 files (5.04s); **UI 92 passed** in 6 files (2.02s) |
| VOICE_TEST_BROWSER_CHANNEL=chrome; pnpm voice:test:e2e | **8 passed**, 32.9s; temporary servers stopped afterward |
| pnpm --filter @data-room-cited/mcp-server test | **85 passed**, 4 files, 5.13s |
| .venv/Scripts/python.exe -m pytest -q --basetemp=.pytest_cache/m3-delivery | **42 passed**, 4.00s, no skips |
| pnpm -r lint; pnpm -r typecheck | Passed for MCP, voice-api and voice-web |
| .venv/Scripts/python.exe scripts/evaluate_release_gate.py --fixture --mcp-contract-passed | **16/16**, all seven release gates passed |
| .venv/Scripts/python.exe -m compileall -q services src scripts app.py | Passed |
| git diff --check | Passed |

Browser coverage includes keyboard start, transcript/evidence, invalid citations,
unsupported/unavailable scenarios, disabled feature, reduced motion/mobile overflow,
the installed React SDK's real hooks against a mocked wire protocol, async client
tool verification, typed messages, permission denial, microphone track cleanup,
SDK error privacy, Host/forwarded-header rejection and denied filesystem access.
Unit/component cases additionally cover cancellation, permission arriving after
unmount, session/connection deadlines, stale verification races, retries, cleanup
failure, bounded responses/transcripts and inert rendering of hostile text.

Browser testing found and fixed a native fetch binding bug that unit mocks did not
expose. SDK declaration incompatibilities and raw error logging were addressed as
described below. An initial filesystem rejection test targeted an absent path and
received the SPA fallback; the final test creates a synthetic secret sentinel,
checks 403/no disclosure and deletes it. No final test failed.

The desktop (1440 px) and mobile (390 px) screenshots were visually inspected:
[desktop](images/voice-m3-desktop.png), [mobile](images/voice-m3-mobile.png).
They show simulated synthetic content, not a live voice session.

## Unresolved issues and next step

No known failing M3 acceptance case remains. These limits remain open:

- **Live provider acceptance:** no real signed-URL usability, speech/turn-taking,
  external MCP access, provider retention, latency or cost was measured. Mock UI
  verification is labelled simulation. The real M2 verification path remains
  covered separately by its Python/MCP integration tests. Live text-only behavior
  also depends on the externally configured agent.
- **SDK declarations:** the installed SDK/LiveKit declarations have missing types
  and strict optional-property conflicts. skipLibCheck is enabled only in the UI;
  application code remains strict. Revisit this on SDK upgrades.
- **Bundle warning:** the lazy live SDK chunk is 602.47 kB minified / 157.69 kB gzip.
  The build passes with Vite's size warning; mock mode does not load this chunk.
- **Diagnostics adaptation:** the pinned SDK's raw console logging is disabled by
  a narrowly scoped build transform. Its browser privacy test must be repeated on
  upgrades. This is not a promise about provider-side retention or browser network
  developer tools; signed URLs are necessarily visible to the connecting browser.
- **Local limits:** the browser duration timer is best effort and not a spending
  cap. M2 quotas are in memory. This remains one synthetic workspace, with no
  private-data or end-user authorization claim. Exact year filtering and PDF page
  numbers are unavailable for the text fixture.
- **Unrun environments:** Linux/Node 22 remote CI, container builds, Safari/Firefox,
  a manual Streamlit browser session and live provider tests were not run. CI is
  configured but no remote execution is claimed.

Recommended next milestone is **M4**: obtain approval for provider configuration
and any controlled external HTTPS route, then perform and record the actual
grounded Q&A, abstention and denied/unavailable-tool scenarios. Preserve the
gateway's read-only controls and synthetic fixture. Deployment is not part of M3.

## References checked

The [official React SDK guide](https://elevenlabs.io/docs/eleven-agents/libraries/react)
and [client tool guide](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools)
were checked on 20 October 2026, along with installed types/source. Installed React
1.19.0 controls return void from startSession/endSession; this implementation uses
connection/disconnection callbacks rather than treating those methods as promises.
The manual external client-tool setup must wait for displayEvidence's response.
