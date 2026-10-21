# M4 provider setup — 21 October 2026

M4 is still incomplete. The approved sandbox agent is configured and inactive.
No tunnel, signed conversation URL, live conversation, deployment or merge was
performed in this setup step.

## Changes actually applied

- The user confirmed the provider-returned workspace ID belongs to the intended
  development/sandbox workspace. A display name was not treated as an API ID.
- Enabled the sandbox's `can_use_mcp_servers` setting through the supported API.
  Readback confirmed all other returned workspace settings were unchanged. No
  initiation or post-call webhook was configured.
- Created the dedicated `displayEvidence` client tool with response waiting and
  a 30-second timeout. Only chunk IDs and quotes are accepted as evidence pairs.
  No provider response mocks were attached.
- Created **Data Room Cited – M4 Voice Demo** from scratch. It is archived, uses
  signed-URL authentication, has no provider hostname allowlist, and has no MCP
  server or knowledge base attached yet. File uploads and monitoring are off.
- Read back audio saving off, one-day retention with transcript/audio deletion,
  and no application of retention changes to existing conversations. Global
  Zero Retention Mode/HIPAA controls were not changed.
- Read back a 300-second call limit, one concurrent conversation, three calls per
  day and bursting disabled. The selected voice/TTS/LLM are the current documented
  provider defaults; their actual IDs are in the configuration plan.

Nonsecret resource identifiers are in `voice-m4/agent-plan.json` and
`voice-m4/acceptance-results.json`. Credentials and request/readback working files
remain under the Git-ignored `.voice-demo/` directory.

Changed repository files: `docs/voice-m4/agent-plan.json`,
`docs/voice-m4/acceptance-results.json`, `docs/voice-m4-approval.md`,
`docs/voice-m4-report.md` and this report. No source, dependency or CI configuration
changed in this step.

## Actual verification

| Check | Result |
|---|---|
| Initial key access | HTTP 401 `missing_permissions`; no mutations attempted until the user corrected scopes. |
| User/workspace, settings and agent-list reads after correction | HTTP 200; no existing agents in this workspace. |
| Client-tool and agent requests against the current official OpenAPI schema | Both passed local validation. |
| Workspace MCP update and readback | HTTP 200; only the requested setting changed. |
| Client-tool creation and readback | HTTP 200; name, parameters, response wait, timeout and absence of provider mocks verified. |
| Agent creation and readback | HTTP 200; authentication, privacy, limits, inactivity and empty MCP/knowledge-base attachments verified. |
| Live acceptance | **Not run**; zero conversations and no cost/latency measurements. |

The provider's parameter model is narrower than arbitrary JSON Schema. The API
request uses its documented object/array/string representation; size limits and
extra-field rejection remain enforced by the existing UI and verification API.
The checked-in strict `display-evidence.schema.json` contract was not weakened.
The client event list explicitly includes `client_tool_call`.

No application source changed. The previously reported credential-free suites
and CI results remain the last application test runs; they are not claimed as
rerun for this provider/documentation step.

## Remaining sequence

Confirm ngrok Traffic Inspector Full Capture is off, then start the approved
20-minute `/mcp` route with local inspection disabled. Verify external route
denials and exactly two authenticated read tools before creating the provider
MCP integration and attaching it to the agent. Unarchive only for the bounded
trial. The human must choose Start/microphone permission and perform the spoken
grounded, abstention and denied/unavailable-tool scenarios. Record observed
results, end sessions, stop the route and detach/disable the demo integration.

The exposure clock has not started. All acceptance scenarios remain `not_run`
and `live_gate_satisfied` remains false. The inactive agent and unattached client
tool can be reused without creating duplicates.

Contracts checked: [official OpenAPI](https://api.elevenlabs.io/openapi.json),
[MCP integration](https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp),
[retention](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention),
[ngrok content capture](https://ngrok.com/security).
