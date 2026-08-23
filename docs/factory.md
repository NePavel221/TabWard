# Factory Droid

TabWard uses a direct user MCP entry plus a Factory plugin that installs the
operating skill.

## Install the local MCP command

```powershell
npm run install:mcp
Get-Command tabward-mcp
```

## Register the MCP

```powershell
$TabWardServer = (Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
droid mcp add tabward node $TabWardServer
```

The direct Node entry avoids Windows `.cmd` subprocess lifecycle issues.
It connects to a shared on-demand broker, so parallel Factory sessions do not
compete for the extension WebSocket port.

## Install the Factory skill

```powershell
droid plugin marketplace add https://github.com/NePavel221/TabWard
droid plugin install tabward@TabWard --scope user
```

Verify the complete integration:

```powershell
droid plugin list --scope user
droid mcp list
```

The plugin contributes `plugins/factory/skills/tabward/SKILL.md`. It does not
register a second MCP process. It teaches Factory to check health and pairing,
prefer managed sessions, observe before acting, respect popup access settings,
and close sessions safely.

Managed sessions provide the everyday frontend QA surface. Use
`clean_qa: true` only when a fresh incognito context is required and TabWard's
Chrome **Allow in incognito** setting is enabled. Keep full-profile adoption
for explicit existing-tab work.
