# HANDOFF

## Current Goal

Continue the 20-task real-use gate for the private `0.3.1` build before
disabling rollback integrations.

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

## Last 5 Tasks

1. 2026-08-23: Implemented lease-backed fail-closed Clean QA and passed its 5/5 incognito gate.
2. 2026-08-23: Passed enhanced frontend QA 12/12, full verify, release audit, and 50/50 endurance without leaks.
3. 2026-08-24: Added evidence-gated post-task TabWard improvement proposals to the Factory skill.
4. 2026-09-14: Added `tabward_upload`, hidden file-input support, local path validation, and passed live frontend QA 12/12.
5. 2026-09-16: Synchronized the verified 0.3.1 source into the canonical checkout and private GitHub repository.

## Next Step

Continue 20 distinct real tasks without fallback, including authenticated
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
- Chrome Reload keeps the extension's existing source directory. To switch
  builds, remove the old unpacked extension and load the intended
  `dist/extension` directory.
