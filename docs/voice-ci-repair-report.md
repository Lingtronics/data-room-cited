# PR #1 CI follow-up — 21 October 2026

## Result and scope

The original push and pull-request workflows were rerun at 17:35 UTC, after the
24-hour release-age window ended at 17:28 UTC. Only their failed jobs were rerun.
Both attempt-2 workflows passed at original head
`ae9fda4064187e93873229f324563be8f278d681`:
[push](https://github.com/Lingtronics/data-room-cited/actions/runs/39510702476),
[pull request](https://github.com/Lingtronics/data-room-cited/actions/runs/39510748875).

Inspection also found advisory failures hidden by the existing nonblocking audit
steps: 9 Python and 19 Node findings (including 7 high-severity Node findings).
Compatible dependency updates resolve the findings in the local audits below.
Both audit steps now block CI. This report records the local validation before
pushing those repairs; the current repaired head's Linux/Node 22 and container
results are recorded in [PR #1 checks](https://github.com/Lingtronics/data-room-cited/pull/1/checks)
and its description once complete.

## Files changed

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | Remove `continue-on-error` from both dependency audits; retain all tests and frozen-lockfile installation. |
| `pnpm-workspace.yaml` | Explicitly retain the 1,440-minute minimum package age, without exceptions. |
| `requirements.txt` | Pin Python MCP 1.30.0; require patched Pillow 13 and Streamlit 1.66.1 or later within compatible major ranges. Streamlit 1.66.1 permits Pillow 13. |
| `apps/mcp-server/package.json` | MCP client/server 2.3.0, Node adapter 2.1.1 and Vitest 4.1.11. |
| `apps/voice-api/package.json` | MCP client 2.3.0 and Vitest 4.1.11. |
| `apps/voice-web/package.json` | Vite 8.2.4 and Vitest 4.1.11. |
| `pnpm-lock.yaml` | Regenerate with compatible patched direct/transitive packages, including Hono, gRPC, nanoid and source-map-js. |
| `tests/test_dependency_compatibility.py` | Add real Streamlit rendering against a temporary synthetic index with no credentials, and Python MCP SDK tool-contract/stdio-isolation coverage with a mocked citation verifier. |
| `README.md` | Update the documented Python MCP pin. |
| `docs/voice-m4-report.md` | Link this subsequent CI validation without changing the live acceptance gate. |
| `docs/voice-ci-repair-report.md` | Record this follow-up. |

No application source or security boundary was relaxed. Scoped authentication,
read-only voice tools, pinned synthetic fixtures, Host/Origin restrictions and
mocked external-service tests remain in place. No deployment, merge, tunnel or
ElevenLabs account/agent changes were performed.

## Actual local validation

Windows, Python 3.12.4, Node 24.18.0 and pnpm 11.25.0:

| Check | Actual result |
|---|---|
| Frozen lockfile install | Passed (`pnpm install --frozen-lockfile`). |
| Python suite | **44 passed**, one Starlette TestClient deprecation warning. |
| Final focused compatibility tests | **2 passed** after adding the diagnostic-output isolation assertion. |
| Python compilation | Passed for `services`, `src`, `scripts` and `app.py`. |
| Synthetic fixture release gate | **16/16 passed**, gate true with the separately passed MCP contracts. |
| MCP tests | **155 passed**, 5 files. |
| Voice API tests | **139 passed**, 7 files. |
| Voice UI tests | **92 passed**, 6 files. |
| MCP/API/UI lint and typecheck | Passed. |
| Voice API/UI production build | Passed. |
| Mocked browser acceptance | **8 passed**, installed Chrome, fake microphone and mocked provider traffic. |
| Python dependency audit | **No known vulnerabilities found**, exit 0 (`pip-audit -r requirements.txt`). |
| Node dependency audit | **No known vulnerabilities found**, exit 0 (`pnpm audit`, all severities). |

The browser suite includes microphone rejection/cleanup, feature-disabled behavior,
independent evidence checks, Host/proxy spoofing rejection and repository-secret
file denial. It performs no live ElevenLabs trials.

## Unresolved items and next step

- M4 live acceptance remains incomplete and all live acceptance entries remain
  `not_run`. Exact sandbox/domain details and private provider access are still
  required for the separately approved bounded trial. Green CI does not satisfy
  witnessed live grounded-answer, abstention or denied-tool acceptance.
- The lazy live SDK bundle emits a 601.77 kB size warning. The existing UI-only
  upstream declaration workaround remains documented in the milestone reports.
- The local virtual environment inherits system packages. Pip reported conflicts
  between unrelated inherited Gradio 5.12 constraints and the patched Pillow /
  Starlette versions; Gradio is not a project dependency. Global packages were
  not changed. No clean `pip check` result is claimed for that shared environment;
  GitHub's fresh Python environment provides the isolated installation check.
- The Starlette TestClient warning does not fail the tests; it can be addressed in
  a future compatibility update.

Follow the repaired head's GitHub workflows with both audits enforced. Keep the
PR draft until the outstanding M4 live acceptance is witnessed; do not deploy or
merge as part of this CI follow-up.
