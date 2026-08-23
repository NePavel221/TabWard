# TabWard

TabWard gives local AI agents controlled access to authenticated Chrome tabs.
It combines a standard stdio MCP server with a paired Chrome extension, so an
agent can use the websites where the user is already signed in without sending
browser traffic through a TabWard cloud service.

> **Status:** private `0.2.0` beta for Windows and Google Chrome. Expect setup
> changes before the first public release.

## Why TabWard

- Uses the real Chrome profile, preserving existing logins and cookies.
- Gives managed sessions access only to tabs created by that session.
- Hides existing user tabs by default.
- Lets the user choose a TabWard group in the current window or a separate
  Chrome window.
- Pairs the local MCP and extension with a one-time six-digit code.
- Exposes 19 `tabward_*` tools for navigation, semantic observation, actions,
  assertions, events, network control, storage, downloads, artifacts, and CDP.
- Keeps the MCP transport on `127.0.0.1`.

## Components

```text
MCP clients -> tabward-mcp -> authenticated localhost broker
            -> paired WebSocket -> TabWard Chrome extension
            -> Chrome APIs and CDP
```

- `packages/mcp/`: client-neutral Node.js stdio MCP server.
- `tabward-broker`: one on-demand process shared by concurrent MCP clients.
- `apps/extension/`: Manifest V3 Chrome extension.
- `plugins/factory/`: optional Factory plugin and TabWard operating skill.
- `packages/protocol/`: protocol constants and compatibility tests.

## Requirements

- Windows 10 or 11.
- Google Chrome 116 or newer.
- Node.js 20 or newer.
- Git access to this private repository.
- Factory Droid for the documented plugin flow, or another stdio MCP client.

## Quick start

Clone the repository and build the verified local artifacts:

```powershell
git clone https://github.com/NePavel221/TabWard.git
Set-Location -LiteralPath '.\TabWard'
npm ci
npm run verify
npm run install:mcp
Get-Command tabward-mcp
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the repository's `dist\extension` directory.

Register the MCP and install the Factory skill:

```powershell
$TabWardServer = (Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
droid mcp add tabward node $TabWardServer
droid plugin marketplace add https://github.com/NePavel221/TabWard
droid plugin install tabward@TabWard --scope user
droid plugin list --scope user
droid mcp list
```

Call `tabward_health`. If pairing is required, enter the displayed six-digit
code in the extension popup. Pairing is normally needed only once.

## Other MCP clients

After the global package install, resolve its server path:

```powershell
Join-Path (npm root --global) '@tabward\mcp\dist\index.js'
```

Configure a standard stdio server with `node` as the command and the printed
absolute path as its only argument. Calling Node directly avoids lifecycle
problems with Windows npm `.cmd` wrappers. The first MCP client starts the
broker on demand; later clients reuse it instead of competing for the extension
port. Factory-specific clients can install
the included skill; other clients use the MCP tool descriptions and the safe
workflow in
[`plugins/factory/skills/tabward/SKILL.md`](plugins/factory/skills/tabward/SKILL.md).

## Access model

- **Managed mode:** works only in tabs created by the current session.
- **Existing tabs:** unavailable unless the user enables
  **Allow access to existing tabs** and starts a full-profile session.
- **Current window:** the default; each session receives its own TabWard group.
- **Separate window:** enabled by the user in the extension popup and fixed for
  the lifetime of the new session.

The extension enforces these settings. An MCP caller cannot silently override
them.

## Documentation

- [Installation and removal](docs/installation.md)
- [Factory integration](docs/factory.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Privacy](PRIVACY.md)
- [Chrome Web Store plan](docs/chrome-web-store.md)

## Development

```powershell
npm ci
npm run verify
```

`npm run verify` checks TypeScript, tests the MCP and extension contracts,
builds the MCP, packages the unpacked extension and Store ZIP, and audits the
release tree for forbidden files and likely secrets.

Run `npm run gate:replacement` after installing the package and reloading the
extension to execute the repeated local browser gate. See
[`docs/replacement-gate.md`](docs/replacement-gate.md).

The private beta intentionally uses this local command as its required
pre-push gate instead of GitHub Actions.

TabWard is licensed under [Apache-2.0](LICENSE).
