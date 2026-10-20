# M4 implementation and trial readiness report

Date: 20 October 2026. **M4 is not complete.** Local code, review templates and
credential-free integration tests are ready. The required real spoken Q&A,
abstention and denied/unavailable-tool trials have not run. The user approved the
bounded trial on 20 October 2026 under the [review package](voice-m4-approval.md).
Execution now awaits account access and exact sandbox/domain targets, not another
approval of that scope.

The user selected an existing development/sandbox workspace, a dedicated agent
named Data Room Cited – M4 Voice Demo and ngrok with a reserved HTTPS development
domain. The exact workspace, agent ID and domain are not yet confirmed. Official
ngrok 3.39.11 is now installed at `.voice-demo/tools/ngrok.exe`, outside PATH and
ignored by Git. No ElevenLabs key/agent ID, ngrok authtoken or reserved origin was
present in the inspected process. Both provider browser pages require sign-in.
No tunnel opened, account setting changed, agent created, deployment performed
or live provider session requested. The 20-minute exposure window
has not started.

## Local implementation

- Added an opt-in, expiring MCP ingress guard. It keeps the gateway on 127.0.0.1
  and defaults to direct local access only. Explicit external settings permit only
  an exact HTTPS Host and /mcp route, trusted loopback transport, validated TLS/
  forwarding metadata and absent or explicitly allowlisted Origin. External
  requests still require the same signed read-only synthetic JWT claims.
- Added a maximum 30-minute configuration window, per-process 120-request/minute
  external budget, four concurrent external slots, 64 KiB voice JSON bodies and
  a 15-second upload/response deadline. Expired routes deny new traffic and close
  pending external responses. API, UI and health endpoints cannot use the route.
- Retained MCP discovery/invocation restrictions and fixture checks. No new tool,
  resource, prompt, document authority, auth bypass or public listener was added.
  Direct local voice requests now also reject proxy forwarding headers.
- Prepared a sandbox agent settings plan, prompt, displayEvidence parameter schema,
  12 synthetic cases, a manual setup/cleanup sequence and an honest live result
  record. Every live result remains not_run; provider costs/latencies remain null.

The extra ingress code does not create or start a tunnel. Tests simulate the
expected HTTPS proxy headers using loopback HTTP; they do not establish TLS or
prove ElevenLabs/ngrok compatibility. The dedicated external gateway in tests
shares only a temporary approved synthetic core and generated test JWT keys.

## Files changed in this milestone

Earlier local, uncommitted M0–M3 changes remain intact. M4 changes are:

| Files | Change |
|---|---|
| apps/mcp-server/src/voiceIngress.ts | Inactive-by-default external configuration, transport guard, limits and bounded body parsing |
| apps/mcp-server/src/voiceIngress.test.ts | 59 credential-free configuration, spoofing, expiry, rate/concurrency and body cases |
| apps/mcp-server/src/config.ts | Connect optional ingress configuration to the existing secure voice profile |
| apps/mcp-server/src/server.ts | Apply guard/deadlines, preserve no-store across SDK SSE responses, pass bounded parsed JSON to SDK, close rejected connections |
| apps/mcp-server/src/voiceGateway.contract.test.ts | Add simulated HTTPS transport tests against real Python/MCP, stalled-upload cleanup and expected-source validation |
| .env.example | Three blank external ingress settings; no domain or credential embedded |
| evals/voice_m4_cases.json | Four grounded single-source, two cross-source, two unsupported, two adversarial, one restricted-tool and one scope-change case |
| docs/voice-m4/agent-plan.json | Reviewable dedicated-agent and ngrok plan; explicitly not an API request |
| docs/voice-m4/agent-prompt.txt | Concise evidence, uncertainty, read-only and injection-handling instructions |
| docs/voice-m4/display-evidence.schema.json | Bounded chunk/quote-only parameter contract; runtime validation remains authoritative |
| docs/voice-m4/acceptance-results.json | Unrun live gate record with no fabricated outcomes or telemetry |
| docs/voice-m4-approval.md, docs/voice-m4-report.md | Approval scope, manual configuration, cleanup, references and this report |
| README.md, docs/voice-agent-setup.md, docs/voice-demo-script.md | Link local preparation and distinguish it from live completion |

No M4 edits were made to Python RAG/FastAPI, Streamlit, the voice API/UI source,
synthetic corpus bytes, existing JWT authorization, dependency manifests/lockfile,
Compose, Dockerfiles or deployment infrastructure.

The approval follow-up changed only `docs/voice-m4-approval.md`, this report,
`docs/voice-m4/agent-plan.json`, `docs/voice-m4/acceptance-results.json` and
`docs/voice-agent-setup.md`. The downloaded CLI and archive are ignored local
artifacts in `.voice-demo/tools`, not repository dependencies. There is no service,
autostart registration or PATH change.

## Actual verification results

Environment: Windows, Node 24.18.0, pnpm 11.25.0, Python 3.12.4 and installed
Chrome. No application dependency installation was performed. Automated services bound only
loopback, generated their own test keys and used synthetic fixtures. Browser
provider traffic and microphone devices were mocked.

| Command | Actual result |
|---|---|
| pnpm --filter @data-room-cited/mcp-server test | **155 passed**, 5 files, 21.22s; includes 70 additions to the M3 baseline of 85 |
| pnpm voice:test | Builds MCP/API/UI; **API 139 passed**, 7 files, 4.28s; **UI 92 passed**, 6 files, 2.74s |
| VOICE_TEST_BROWSER_CHANNEL=chrome; pnpm voice:test:e2e | **8 passed**, 32.5s; installed Chrome, fake microphone and mocked provider |
| .venv/Scripts/python.exe -m pytest -q --basetemp=.pytest_cache/m4-preparation | **42 passed**, 3.50s |
| pnpm -r lint; pnpm -r typecheck | Passed for MCP, voice-api and voice-web |
| .venv/Scripts/python.exe -m compileall -q services src scripts app.py | Passed |
| .venv/Scripts/python.exe scripts/evaluate_release_gate.py --fixture --mcp-contract-passed | **16/16**, release_gate_passed=true |
| git diff --check | Passed |

The 12 evaluation cases were loaded and their expected source excerpts verified
through the real Python/MCP path. This confirms fixture provenance, not agent
answers, abstention or probabilistic tool choice. No provider agent tests were
created or executed. The result record preserves this distinction.

Initial integration tests found two issues that were fixed: the SDK overwrote
no-store with its SSE cache header, and an oversized request left an incomplete
HTTP body on a reusable connection. The final wrapper preserves no-store and
rejections close the connection. A real stalled-upload test confirms the deadline
closes the request and releases capacity. Type checks also caught test-helper and
SDK wrapper signature mistakes before the final passing runs.

### Checks after bounded-trial approval

These checks were performed after installation; the application suites above
were not rerun for the documentation-only follow-up.

| Check | Actual result |
|---|---|
| Official Windows x64 archive | Downloaded from the official ngrok download link; archive contains only ngrok.exe |
| Windows Authenticode | **Valid**, publisher **ngrok, Inc.**; certificate-network access was needed to complete validation |
| ngrok version | **3.39.11**, exit 0 |
| ngrok http --help | Exit 0; --url and --inspect supported |
| Process check | **0** running ngrok processes; no tunnel started |
| Git ignore check | CLI executable and archive both ignored |
| Synthetic fixture integrity | **Passed**, all 5 pinned corpus/index files unchanged |
| Updated JSON plans/results | Both parsed successfully |
| git diff --check | Passed; existing lockfile/workspace line-ending warnings only |

Download URL and artifact hashes are recorded in the approval package. The
signature was verified before running the binary. No security protection was
disabled and no ngrok configuration/authtoken was created.

## Open items within the approved scope

1. Confirm the sandbox workspace ID/name and reserved ngrok HTTPS domain. Verify
   account access, compatible privacy controls and approved sandbox voice/model,
   within the already approved session limits.
   Credentials must be provisioned privately; none should enter chat or Git.
2. With those prerequisites available, use the approved 20-minute temporary route
   and sandbox MCP/demo-agent setup. Installation is complete. The approved scope
   includes audio saving off, one-day retention for new demo conversations and a
   five-minute call limit. No global privacy downgrade or production edit is allowed.
3. After readback and external security checks, run the proposed maximum three
   five-minute spoken trials and record observed results. M4's gate requires one
   grounded answer with an actually verified visible citation, one abstention and
   one denied/unavailable-tool scenario. Then perform and record cleanup.
4. Additional provider framework tests require an approved test budget. Use current
   Agent Testing / run-tests, not the deprecated simulate-conversation API. Live
   privacy, cost, latency, interruptions and text-only behavior remain unmeasured.

M3's known 602.47 kB lazy live SDK chunk warning and UI-only skipLibCheck workaround
remain. Linux/Node 22 remote CI, container builds and a manual Streamlit session
were not run here. No claim of production denial-of-service protection, zero
retention, private-document access or end-user identity isolation is made.

The next step is **provider sign-in/private credential provisioning and exact
target details**, followed by the already approved external M4 trial. Do not
advance to a completed-M4 claim or deploy on the basis of local
tests alone. Official SDK, MCP, authentication, privacy, ngrok and current testing
references are linked in the [approval package](voice-m4-approval.md).
