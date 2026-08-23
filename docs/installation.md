# Installation

## Requirements

- Windows 10 or 11.
- Google Chrome 116 or newer.
- Node.js 20 or newer.
- Factory Droid.
- Git access to the private TabWard repository.

## Clone and build

```powershell
git clone https://github.com/NePavel221/TabWard.git
Set-Location -LiteralPath '.\TabWard'
npm ci
npm run verify
npm run install:mcp
Get-Command tabward-mcp
```

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the repository's `dist\extension` directory.

For fail-closed Clean QA:

1. Open the TabWard details page in `chrome://extensions`.
2. Enable **Allow in incognito** only for TabWard.
3. Run `npm run gate:clean-qa`.

Regular managed sessions do not require incognito access.

## Factory MCP and skill

Register the globally installed MCP by its real JavaScript entry point, then
install the plugin that contributes the TabWard skill:

```powershell
$TabWardServer = (Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
droid mcp add tabward node $TabWardServer
droid plugin marketplace add https://github.com/NePavel221/TabWard
droid plugin install tabward@TabWard --scope user
droid plugin list --scope user
droid mcp list
```

Call `tabward_health`. If it reports `pairing_required`, enter the six-digit
code in the TabWard popup. Never share the resulting pairing token.

The popup initially follows Chrome's language when it is Russian or English.
Changing the popup language applies immediately and persists in the extension.

## Direct stdio MCP

For another MCP client, use `node` as the stdio command and this path as its
only argument:

```powershell
(Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
```

Do not configure the npm `.cmd` wrapper as the subprocess on Windows; some MCP
clients cannot terminate its child Node process cleanly. Multiple TabWard MCP
processes are supported: they discover and reuse one on-demand local broker.

## Update

```powershell
Set-Location -LiteralPath '.\TabWard'
git pull --ff-only
npm ci
npm run verify
npm run install:mcp
droid plugin marketplace update TabWard
droid plugin update tabward@TabWard --scope user
```

## Uninstall

1. Remove or disable the unpacked TabWard extension.
2. Run `droid plugin uninstall tabward@TabWard`.
3. Run `droid mcp remove tabward`.
4. Run `npm uninstall --global @tabward/mcp`.
5. Stop any remaining TabWard MCP process.
6. Stop the remaining `tabward-broker` process.
7. Delete `%LOCALAPPDATA%\TabWard` only if its pairing and local artifacts are
   no longer needed.
