# HANDOFF

## Current Goal

Stage Two reliability is complete in the isolated worktree. Do not begin Stage
Three concurrency or Canvas work without explicit approval.

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

The isolated `perf/tabward-stage2-20260921` worktree now carries one absolute
deadline and operation ID through MCP, broker HTTP, the retained global bridge
queue, WebSocket, extension operation context, durable outbox, and result
acknowledgement. Queue expiry and cancellation fail before browser dispatch;
post-dispatch loss remains typed `OutcomeUnknown`. Duplicate operation IDs join
the same in-flight/cached result, while fingerprint conflicts fail closed.

Extension handlers no longer depend on shared active-session or active-signal
globals. A serialized StateStore protects short session-state mutations.
Sessions transition through `active` → `closing` → `closed` or
`cleanup_partial`; cleanup receives a TTL pin, and failed or unverified tab
removal preserves ownership for retry. Bounded byte/count budgets cover the
broker ledger, extension outbox, events, traces, screencast frames, and
all-frame aggregates. Expired orphan reservations become replayable
`OutcomeUnknown` tombstones. Partial QA cannot report green.

Review hardening now treats WebSocket send callback failures and deadline
aborts after dispatch as effect-unknown, keeps extension results until the
broker has bounded recovery capacity, and replays completion to the current
authenticated socket after reconnect. Late confirmed results replace matching
settled unknown ledger outcomes. Read-only broker restart recovery reuses the
original request/operation identity and absolute deadline. Nested-frame double
click now emits two clicks plus `dblclick`; retained partial child frames make
their aggregate partial. The privacy draft now discloses bounded local
full-result retention in extension IndexedDB and broker memory.

Revalidation hardening now passes immutable operation/session context through
every nested ownership helper. Managed navigate, read, action, download, close,
release, cleanup, handoff, deliverable, and visual-state paths no longer fall
back to the legacy browser session. Ownership updates after asynchronous
Chrome work use fresh serialized key-level mutations, so open-tab, child-tab,
remember, forget, grouping, and adoption interleavings do not replace the
whole ownership map. `networkBody` is bounded to a 7 MiB result inside its
8 MiB durable reservation and marks larger bodies truncated/partial.
All-frame completeness now recognizes structured `truncated`,
`outputTruncated`, and nested incomplete evidence.

Frame/document identity is preserved for targeted scripting. Nested-frame
uploads use a unique frame marker mapped to a CDP backend node; nested native
actions use frame-local DOM paths or fail closed. Nested-frame element
screenshot coordinates and full OOPIF coordinate-chain capture remain
explicitly deferred. Automatic MCP-death detection and handle-based large
artifact transfer are also deferred.

Validation passes: all targeted Stage Two regressions, full `npm run verify`
including release audit, and the isolated 1/2/4 benchmark. Benchmark p95 total
was 93.19/186.19/371.37 ms; max queue depth remained 0/1/3 and execution stayed
globally sequential. No live Chrome, global MCP install, standard ports,
pairing/config changes, commit, push, or publish was used.

## Last 7 Tasks

1. 2026-08-23: Passed enhanced frontend QA 12/12, full verify, release audit, and 50/50 endurance without leaks.
2. 2026-08-24: Added evidence-gated post-task TabWard improvement proposals to the Factory skill.
3. 2026-09-14: Added `tabward_upload`, hidden file-input support, local path validation, and passed live frontend QA 12/12.
4. 2026-09-16: Synchronized the verified 0.3.1 source into the canonical checkout and private GitHub repository.
5. 2026-09-21: Implemented isolated Stage One telemetry, benchmark, QA artifact, unchecked-wait, and download-ownership changes with synthetic regressions.
6. 2026-09-21: Implemented Stage Two deadlines, cancellation/outcomes, operation ledger/outbox recovery, serialized state lifecycle, byte budgets, and frame-safe foundations.
7. 2026-09-21: Resolved Stage Two review and revalidation findings with deterministic ownership, interleaving, budget, and completeness regressions.

## Next Step

Review the uncommitted Stage Two diff. Stage Three concurrency and Canvas work
await explicit permission.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- Do not claim full replacement readiness until the real-use gate reaches 20/20.
- Do not disable Playwright MCP or remove the legacy integration before their
  real-use/parity gates pass.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Keep `#commandTail` and sequential execution until Stage Three is explicitly
  approved.
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
