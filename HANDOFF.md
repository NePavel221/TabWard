# HANDOFF

## Current Goal

Stage Three controlled concurrency is installed and live-validated from the
isolated `perf/tabward-stage3-20260921` worktree. Preserve Stage Two reliability
and do not begin Canvas work without explicit approval.

## Current State

TabWard `0.3.1` is a verified local release candidate. It exposes 23 MCP tools,
including the dedicated `tabward_upload` tool. Uploads validate readable
absolute local file paths and attach them through CDP without opening the
operating-system picker. Hidden `input[type=file]` elements are supported.
The release also retains forms, probes, composite frontend QA, iframe/scoped
screenshot support, history navigation, loopback-only managed evaluate,
fail-closed Clean QA, and persistent English/Russian popup selection.
The extension now uses the user-selected Lighthouse icon from a committed SVG
source and reproducibly generates 16/32/48/128/1024 px PNG assets.

Final `npm run verify` and release audit pass. Frontend QA passes 12/12,
including restoration of pre-existing emulation and events; Clean QA passes
5/5; replacement endurance passes 50/50 without leaked tabs; managed live smoke
passes with isolated workspace and existing-tab access denied. The hidden-file
upload gate passes live. The unpacked 0.3.1 extension is rebuilt, paired, and
connected in the user's Chrome. The global MCP is installed from Stage Three,
and the local Factory skill cache remains at 0.3.1. The Stage Three branch
remains local and is not merged or pushed. Sanitized reports remain under
`.factory/temp/` and are not committed.
The Factory skill now performs a silent post-task review after real TabWard
use. It proposes at most one evidence-backed, high-leverage TabWard improvement
and stays silent when the task revealed no strong reusable opportunity.

The broker now uses a bounded fair per-session scheduler with FIFO inside each
session, round-robin service across sessions, same-tab serialization, and a
global-exclusive lane for Clean QA, cleanup, profile storage, unknown scope,
expert CDP, and ambiguous download correlation. Queue cancellation, expiry,
and per-session/total backpressure remain typed pre-dispatch outcomes. Maximum
concurrency is validated to `1..4`; production defaults to `2`, while maximum
`1` reproduces Stage Two global ordering. Global work retains its origin
session and active plus queued work shares the per-session admission bound.
Legacy `executeCdp` and unknown aliases are global-exclusive. Global
round-robin now checks the exact selected item's sequence barrier, preserves
same-origin FIFO across ordinary/global lanes, and scans for another eligible
origin instead of starting a blocked later item.

The extension accepts concurrent dispatch with immutable operation context and
a session/tab/global resource gate. CDP events, interception, emulation,
tracing, and screencast ownership prevent expert commands or timeout cleanup
from disabling resources still owned by another operation. Claims are exact to
one operation; duplicate same-session starts fail busy. Cleanup preserves
resources owned by another session. Trace stop retains a `stopping` owner
across timeout or cancellation and releases it only after confirmed
completion. Concurrent outbox
completion/ACK, reconnect recovery, four-session correlation isolation,
disconnect/cancel/deadline/late-result faults, and 50-cycle scheduler endurance
have deterministic regression coverage.

Session close enters `closing`, rejects new commands, drains work already
accepted by that MCP process, and then performs global-exclusive cleanup.
Accepted ownership mutations cannot shorten the closing TTL pin. Adopted and
user tabs remain protected. Stage Two operation identity,
deadlines, durable outbox, ledger recovery, byte budgets, and
`OutcomeUnknown` behavior remain intact.

Validation passes: targeted Stage Three tests, full `npm run verify` including
release audit, and the isolated 1/2/4 scheduler/client benchmark. Three
repeated post-review runs confirmed maximum `2`: median p95 total was about
`94.8 ms` for one client and `186.9 ms` for four clients, versus Stage Two
`93.19/371.37 ms`. That is about a 1.7% one-client regression and a 49.7%
four-client improvement. Maximum `4` remains benchmark/test-only. No live
Chrome, global MCP install, standard ports, pairing/config changes, push, or
publish was used during isolated development.

The installed Stage Three build now passes live managed smoke, frontend QA
12/12, Clean QA 5/5, four-client/four-session isolation with production
concurrency `2`, and the 50-cycle replacement gate 50/50 with no leaked tabs.
Health reports the paired extension connected with zero active sessions.

## Last 7 Tasks

1. 2026-09-14: Added `tabward_upload`, hidden file-input support, local path validation, and passed live frontend QA 12/12.
2. 2026-09-16: Synchronized the verified 0.3.1 source into the canonical checkout and private GitHub repository.
3. 2026-09-21: Implemented isolated Stage One telemetry, benchmark, QA artifact, unchecked-wait, and download-ownership changes with synthetic regressions.
4. 2026-09-21: Implemented Stage Two deadlines, cancellation/outcomes, operation ledger/outbox recovery, serialized state lifecycle, byte budgets, and frame-safe foundations.
5. 2026-09-21: Resolved Stage Two review and revalidation findings with deterministic ownership, interleaving, budget, and completeness regressions.
6. 2026-09-21: Implemented and review-hardened Stage Three bounded fair concurrency, resource isolation, close draining, deterministic faults/endurance, and the 1/2/4 benchmark matrix.
7. 2026-09-22: Selected and installed the Lighthouse icon, installed Stage Three in Chrome, and passed smoke, Clean QA, four-session concurrency, and 50-cycle live gates.

## Next Step

Continue the sanitized 20-task real-use gate before disabling any rollback
browser integration. No immediate implementation task is pending. Canvas
remains deferred.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- Do not claim full replacement readiness until the real-use gate reaches 20/20.
- Do not disable Playwright MCP or remove the legacy integration before their
  real-use/parity gates pass.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Keep the production scheduler default at `2` unless later live evidence
  justifies another value; maximum `4` is benchmark/test coverage only.
- Do not claim exactly-once execution across a crash between browser effect and
  durable completion; the supported outcome is `OutcomeUnknown`.
- Do not auto-close tabs during orphan reconciliation or claim an unproven
  debugger attachment after an MV3 restart.
- Nested-frame element screenshots fail closed until a verified OOPIF
  frame-to-top coordinate chain is implemented.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Broker runtime credentials under `%LOCALAPPDATA%\TabWard` are also sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
- Chrome Reload keeps the extension's existing source directory. To switch
  builds, remove the old unpacked extension and load the intended
  `dist/extension` directory.
