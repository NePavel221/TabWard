# HANDOFF

## Current Goal

Continue the 20-task real-use gate for the private `0.3.0` build before
disabling rollback integrations.

## Current State

TabWard `0.3.0` is a verified local release candidate. It exposes 22 MCP tools,
adds forms, probes, composite frontend QA, iframe/scoped screenshot support,
history navigation, loopback-only managed evaluate, fail-closed Clean QA, and
persistent English/Russian popup selection.

Final `npm run verify` and release audit pass. Frontend QA passes 12/12,
including restoration of pre-existing emulation and events; Clean QA passes
5/5; replacement endurance passes 50/50 without leaked tabs; managed live smoke
passes with isolated workspace and existing-tab access denied. The unpacked
0.3.0 extension is rebuilt and connected. The source is pushed to private
`main`; the global MCP and Factory plugin are installed at 0.3.0. Sanitized
reports remain under `.factory/temp/` and are not committed.

## Last 3 Tasks

1. 2026-08-23: Added the 22-tool Managed QA surface and persistent English/Russian popup.
2. 2026-08-23: Implemented lease-backed fail-closed Clean QA and passed its 5/5 incognito gate.
3. 2026-08-23: Passed enhanced frontend QA 12/12, full verify, release audit, and 50/50 endurance without leaks.

## Next Step

Complete 20 distinct real tasks without fallback, including authenticated
reads, multi-step scenarios, navigation, forms, child tabs, downloads, and
cleanup. Record only sanitized outcomes.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- Do not claim full replacement readiness until the real-use gate reaches 20/20.
- Do not disable Playwright MCP or remove the legacy integration before their
  real-use/parity gates pass.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Broker runtime credentials under `%LOCALAPPDATA%\TabWard` are also sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
