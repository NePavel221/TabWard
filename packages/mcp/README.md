# @tabward/mcp

Local stdio MCP server for the TabWard Chrome extension.

Install an independent global copy from the TabWard repository root:

```powershell
npm run install:mcp
Get-Command tabward-mcp
```

On Windows, configure `node` as the stdio command and the result of the
following command as its only argument:

```powershell
(Join-Path (npm root --global) '@tabward\mcp\dist\index.js').Replace('\', '/')
```

This avoids npm `.cmd` subprocess lifecycle issues. The server binds a paired
WebSocket only to `127.0.0.1` and does not operate a cloud browser service. The
npm package is not publicly published yet.
