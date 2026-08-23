# HANDOFF

## Current Goal

Dogfood the pushed `0.2.0` build in real browser tasks before disabling the
legacy browser MCP and skill in Factory.

## Current State

TabWard `0.2.0` is implemented and installed locally. Multiple stdio MCP clients
share one authenticated on-demand broker instead of competing for the extension
port. Protocol v2 adds idempotent broker requests, bounded result retention, an
acknowledged IndexedDB extension outbox, automatic broker restart, and
`OutcomeUnknown` for unconfirmed side-effecting actions. The 19 existing tools
remain compatible; tab lifecycle operations now also expose finish, handoff,
and deliverable states.

The full local `npm run verify` passes. The automated replacement gate passed
50/50 cycles without leaked tabs. A 10-cycle alternating local comparison passed
10/10 for both tools; TabWard measured p50 1.14 s and p95 1.40 s versus the
legacy integration's p50 1.19 s and p95 11.30 s. A real broker restart followed
by an installed-package smoke passed 3/3. Sanitized reports stay under
`.factory/temp/` and are not committed.

## Last 3 Tasks

1. 2026-08-23: Implemented the shared broker, protocol v2 recovery, strict MCP validation, and lifecycle operations.
2. 2026-08-23: Passed 50/50 replacement cycles, broker restart recovery, and the comparative local benchmark.
3. 2026-08-19: Published and installed the initial private beta.

## Next Step

Use the pushed private `0.2.0` build for 20 distinct real tasks without
fallback: at least five
authenticated read scenarios and five multi-step scenarios, plus navigation,
forms, child tabs, downloads, and cleanup. Record only sanitized outcomes.
After all 20 pass with no critical/high defects, rerun the full gate and then
disable the legacy MCP and skill.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- Private `main` commit `0357e75` contains the `0.2.0` dogfooding build, and
  the installed Factory plugin resolves to that commit.
- Do not claim full replacement readiness until the real-use gate reaches 20/20.
- Do not disable the legacy integration before the real-use gate passes.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Broker runtime credentials under `%LOCALAPPDATA%\TabWard` are also sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
