# Project Instructions

## Purpose

TabWard is a local-first Chrome extension and MCP server that let AI agents work
in authenticated, agent-owned Chrome tabs.

## Source of truth

1. Current files and Git state.
2. `AGENTS.md`, `README.md`, `HANDOFF.md`, and `TROUBLESHOOTING.md`.
3. Relevant files under `docs/`.
4. Fresh user instructions.

## Important paths

- `apps/extension/`: unpacked Manifest V3 extension source.
- `packages/mcp/`: publishable local stdio MCP package.
- `packages/protocol/`: protocol contracts and compatibility tests.
- `plugins/factory/`: Factory plugin and operating skill.
- `scripts/`: release packaging and audit helpers.

## Safety

- Keep every browser transport bound to `127.0.0.1`.
- Never commit pairing secrets, browser data, cookies, storage, downloads,
  artifacts, logs, traces, or generated packages.
- Managed sessions may access only tabs created by that session.
- Existing user tabs require an explicit full-profile adoption flow.
- Do not change repository visibility or publish npm/Chrome packages without
  explicit user approval.

## Validation

GitHub Actions is intentionally not used during the source beta. Run
`npm run verify` locally after code changes and before every push. Run
`npm run audit:release` before a release candidate. Run the live Chrome smoke
only in a TabWard-owned test session and close only test-created tabs.

## Project memory

- `HANDOFF.md` records current implementation state and next steps.
- `TROUBLESHOOTING.md` records reproducible failures and proven fixes.
- Durable architecture and release details belong under `docs/`.
