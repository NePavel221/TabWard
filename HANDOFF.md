# HANDOFF

## Current Goal

Stage Three controlled concurrency is complete in the isolated
`perf/tabward-stage3-20260921` worktree. Preserve Stage Two reliability and do
not begin Canvas work without explicit approval.

## Current State

TabWard `0.3.1` is a verified local release candidate. It exposes 23 MCP tools,
including the dedicated `tabward_upload` tool. Uploads validate readable
absolute local file paths and attach them through CDP without opening the
operating-system picker. Hidden `input[type=file]` elements are supported.
The release also retains forms, probes, composite frontend QA, iframe/scoped
screenshot support, history navigation, loopback-only managed evaluate,
fail-closed Clean QA, and persistent English/Russian popup selection.

Final `npm run verify` and release audit pass. Frontend QA passes 12/12,
including restoration of pre-existing emulation and events; Clean QA passes
5/5; replacement endurance passes 50/50 without leaked tabs; managed live smoke
passes with isolated workspace and existing-tab access denied. The hidden-file
upload gate passes live. The unpacked 0.3.1 extension is rebuilt, paired, and
connected. The global MCP and local Factory skill cache are installed at 0.3.1.
The canonical source is synchronized into the desktop checkout and private
GitHub `main`; it matches the locally verified marketplace implementation.
Sanitized reports remain under `.factory/temp/` and are not committed.

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
publish was used.

## Last 7 Tasks

1. 2026-08-24: Added evidence-gated post-task TabWard improvement proposals to the Factory skill.
2. 2026-09-14: Added `tabward_upload`, hidden file-input support, local path validation, and passed live frontend QA 12/12.
3. 2026-09-16: Synchronized the verified 0.3.1 source into the canonical checkout and private GitHub repository.
4. 2026-09-21: Implemented isolated Stage One telemetry, benchmark, QA artifact, unchecked-wait, and download-ownership changes with synthetic regressions.
5. 2026-09-21: Implemented Stage Two deadlines, cancellation/outcomes, operation ledger/outbox recovery, serialized state lifecycle, byte budgets, and frame-safe foundations.
6. 2026-09-21: Resolved Stage Two review and revalidation findings with deterministic ownership, interleaving, budget, and completeness regressions.
7. 2026-09-21: Implemented and review-hardened Stage Three bounded fair concurrency, resource isolation, close draining, deterministic faults/endurance, and the 1/2/4 benchmark matrix.

## Next Step

With explicit approval, run the live Chrome frontend QA, Clean QA,
upload/download, multi-session concurrency, and cleanup/endurance gates in a
TabWard-owned test profile before any installation or rollout. Canvas remains
deferred.

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
