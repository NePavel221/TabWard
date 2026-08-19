# HANDOFF

## Current Goal

No active implementation task.

## Current State

TabWard `0.1.0` is ready for its first private GitHub snapshot. The client-neutral
Node stdio MCP, paired localhost WebSocket, managed/full-profile policy, 19 MCP
tools, Chrome extension, Factory skill plugin, installer, tests, and release
packaging are implemented. The extension popup enforces existing-tab access and
current-group versus separate-window settings; both default to off.

The local independent MCP package and Factory skill plugin are installed for
the repository owner. A global-package live smoke passed pairing, managed
ownership, current-window grouping, semantic observation, and cleanup.

## Last 3 Tasks

1. 2026-08-19: Prepared portable private-beta installation and Factory skill packaging.
2. 2026-08-19: Removed legacy extension namespaces and passed global-package live smoke.
3. 2026-08-19: Added and live-tested extension-enforced tab access and workspace settings.

## Next Step

Create and review the clean initial commit, then publish `main` only to the
private `NePavel221/TabWard` repository.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- The npm package and Chrome Web Store extension are not publicly published.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
