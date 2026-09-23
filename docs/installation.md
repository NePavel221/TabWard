# Installation

## Requirements

- Windows 10 or 11.
- Google Chrome 116 or newer.
- Node.js 20 or newer.
- Factory Droid.
- Git access to the TabWard repository.

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

Before starting `full_profile`, enable **Allow access to existing tabs** in the
popup. This is the master human toggle; the MCP checks it before creating the
session and the extension rechecks it before every privileged operation.

For local uploads, add only exact trusted HTTPS hosts such as
`uploads.example.com`. Wildcards are rejected. Unknown hosts require a popup
approval bound to the actual target frame/document and rechecked at dispatch.
For sensitive raw CDP, approve the exact method and parameters shown in the
popup; approvals expire after five minutes and do not grant a session-wide
exception. The extension icon badge shows the number of active requests, and
all open popup views hide a request after another popup decides it.

## Direct stdio MCP

For another MCP client, use `node` as the stdio command and this path as its
only argument:

```powershell
(Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
```

Do not configure the npm `.cmd` wrapper as the subprocess on Windows; some MCP
clients cannot terminate its child Node process cleanly. Multiple TabWard MCP
processes are supported: they discover and reuse one on-demand local broker.

## Scheduler configuration

Stage Three defaults to two concurrent commands across independent sessions.
The broker validates the following environment variables at startup:

```powershell
$env:TABWARD_SCHEDULER_MAX_CONCURRENCY = '1' # compatibility, or 2/4
$env:TABWARD_SCHEDULER_MAX_QUEUE_PER_SESSION = '64'
$env:TABWARD_SCHEDULER_MAX_QUEUE_TOTAL = '256'
```

`TABWARD_SCHEDULER_MAX_CONCURRENCY` accepts only integers from `1` through `4`;
invalid values use the conservative default `2`. Queue values also have bounded
validation and never expose session names, URLs, or browser content. Restart
the local broker after changing startup configuration.

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

Reload Chrome from the newly verified `dist\extension` directory after every
extension update. Chrome's Reload button does not change which source
directory was originally selected.

The repository is public, but the npm package and Chrome Web Store extension
are not published. Installing `0.4.0` from source is still a beta workflow;
review permissions and the Store listing separately before distribution.

## Uninstall

1. Remove or disable the unpacked TabWard extension.
2. Run `droid plugin uninstall tabward@TabWard`.
3. Run `droid mcp remove tabward`.
4. Run `npm uninstall --global @tabward/mcp`.
5. Stop any remaining TabWard MCP process.
6. Stop the remaining `tabward-broker` process.
7. Delete `%LOCALAPPDATA%\TabWard` only if its pairing and local artifacts are
   no longer needed.
