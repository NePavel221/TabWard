# HANDOFF

## Current Goal

No active implementation task.

## Current State

TabWard `0.1.0` is ready for its first private GitHub snapshot. The client-neutral
Node stdio MCP, paired localhost WebSocket, managed/full-profile policy, 19 MCP
tools, Chrome extension, Factory skill plugin, installer, tests, and release
packaging are implemented. The extension popup enforces existing-tab access and
current-group versus separate-window settings; both default to off.

The independent MCP package is installed globally for the repository owner.
The Factory marketplace and skill were installed successfully from the private
GitHub URL, not a local path. A global-package live smoke passed pairing,
managed ownership, current-window grouping, semantic observation, and cleanup.

## Last 3 Tasks

1. 2026-08-19: Completed the private GitHub beta and chose local pre-push verification.
2. 2026-08-19: Published the initial private `main` and installed its Factory skill from GitHub.
3. 2026-08-19: Prepared portable private-beta installation and Factory skill packaging.

## Next Step

No pending implementation task. Keep the repository private until a separate
public-release review.

## Risks / Do Not Forget

- Keep the GitHub repository private until a separate public-release review.
- The npm package and Chrome Web Store extension are not publicly published.
- GitHub Actions is intentionally absent during the private beta. Local
  `npm run verify` is mandatory before every push.
- Pairing tokens under `%LOCALAPPDATA%\TabWard` are sensitive.
- Existing user tabs must remain inaccessible in managed mode.
- Keep existing-tab access disabled by default; disabling it releases adopted
  tabs without closing them.
