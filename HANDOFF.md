# HANDOFF

## Current Goal

Review isolated Stage One performance/safety changes. Do not begin Stage Two
concurrency work without separate approval.

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

The isolated `perf/tabward-stage1-20260921` worktree now has opt-in anonymous
operation telemetry, a reproducible 1/2/4-client synthetic benchmark, unique
exclusive-create QA artifact defaults, strict `unchecked` waits, and
session-owned download list/delete behavior. The bridge remains globally
sequential. No live Chrome, global MCP installation, standard port, commit, or
push was used.

Confirmed review fixes make telemetry opt-in per operation without restarting
the persistent broker, preserve foreign-session download records at the
bounded limit, require genuine checkable locator semantics for `unchecked`,
and clean benchmark child/temp resources on startup failure.

Final validation adds pre-side-effect download ownership reservations with
session-release cleanup and failure compensation. Checkable snapshots are now
tri-state, preserving native indeterminate and ARIA mixed rather than treating
them as unchecked.

An accepted download click that reaches the observation timeout now returns a
typed `OutcomeUnknown` with non-sensitive retry metadata while retaining its
reservation; the MCP client does not retry the click automatically.

## Last 6 Tasks

1. 2026-08-23: Implemented lease-backed fail-closed Clean QA and passed its 5/5 incognito gate.
2. 2026-08-23: Passed enhanced frontend QA 12/12, full verify, release audit, and 50/50 endurance without leaks.
3. 2026-08-24: Added evidence-gated post-task TabWard improvement proposals to the Factory skill.
4. 2026-09-14: Added `tabward_upload`, hidden file-input support, local path validation, and passed live frontend QA 12/12.
5. 2026-09-16: Synchronized the verified 0.3.1 source into the canonical checkout and private GitHub repository.
6. 2026-09-21: Implemented isolated Stage One telemetry, benchmark, QA artifact, unchecked-wait, and download-ownership changes with synthetic regressions.

## Next Step

Review the uncommitted Stage One diff and benchmark. Stage Two (removing global
head-of-line blocking or enabling concurrency) requires separate approval.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- Do not claim full replacement readiness until the real-use gate reaches 20/20.
- Do not disable Playwright MCP or remove the legacy integration before their
  real-use/parity gates pass.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Keep `#commandTail` and sequential execution until Stage Two is explicitly
  approved.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Broker runtime credentials under `%LOCALAPPDATA%\TabWard` are also sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
- Chrome Reload keeps the extension's existing source directory. To switch
  builds, remove the old unpacked extension and load the intended
  `dist/extension` directory.
