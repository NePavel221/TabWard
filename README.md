# TabWard

TabWard gives local AI agents controlled access to authenticated Chrome tabs.
It combines a standard stdio MCP server with a paired Chrome extension, so an
agent can use the websites where the user is already signed in without sending
browser traffic through a TabWard cloud service.

> **Status:** private `0.3.1` beta for Windows and Google Chrome. Expect setup
> changes before the first public release.

## Why TabWard

- Uses the real Chrome profile, preserving existing logins and cookies.
- Gives managed sessions access only to tabs created by that session.
- Hides existing user tabs by default.
- Lets the user choose a TabWard group in the current window or a separate
  Chrome window.
- Pairs the local MCP and extension with a one-time six-digit code.
- Exposes 23 `tabward_*` tools, including forms, local file attachment, structured probes, composite
  frontend QA, screenshots, assertions, events, emulation, downloads, and CDP.
- Offers fail-closed Clean QA in a separate incognito window when Chrome's
  **Allow in incognito** setting is enabled for TabWard.
- Restricts managed JavaScript evaluation to loopback pages.
- Provides a persistent English/Russian extension interface; the initial
  language follows Chrome and manual selection is saved.
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
- **Managed QA:** includes forms, uploads, screenshots, probes, events,
  tracing, emulation, and loopback-only evaluate in owned tabs.
- **Clean QA:** `clean_qa: true` creates a separate incognito window only
  after proving that no other incognito window exists. TabWard closes only its
  owned Clean QA window and fails closed if ownership cannot be proven.
- **Existing tabs:** unavailable unless the user enables
  **Allow access to existing tabs** and starts a full-profile session.
- **Current window:** the default; each session receives its own TabWard group.
- **Separate window:** enabled by the user in the extension popup and fixed for
  the lifetime of the new session.

The extension enforces these settings. An MCP caller cannot silently override
them.

## Attach local files

Use `tabward_upload` to attach files without opening the Windows file picker.
Pass one or more absolute local paths and, when needed, a locator for the
corresponding `input[type=file]`. If the page has exactly one file input, the
locator may be omitted. Hidden file inputs used by custom attachment buttons
are supported. TabWard verifies that every requested path is a readable file
before the browser receives it; choosing a directory or a missing file fails
without interacting with the page.

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

Run the dedicated frontend gates against the loaded extension:

```powershell
npm run gate:qa
npm run gate:clean-qa
```

The Clean QA gate requires **Allow in incognito** for TabWard.

Run the isolated synthetic Stage One performance baseline:

```powershell
npm run benchmark:stage1
```

It starts its own broker and synthetic WebSocket extension on dynamic loopback
ports, uses a temporary state directory, measures 1/2/4 simultaneous clients,
prints p50/p95 queue, execution, total, result-size, and RSS samples, and
removes only its own temporary resources. It does not use the loaded Chrome
extension or the standard ports.

Stage Two keeps the same global sequential executor while adding one absolute
deadline and operation ID across MCP, broker HTTP, WebSocket, extension
dispatch, durable outbox, and result acknowledgement. Queue time consumes the
deadline. Expired or queued-cancelled work fails before browser dispatch;
timeouts or disconnects after dispatch remain `OutcomeUnknown` and are never
blindly retried for actions.

The broker and extension maintain bounded operation/result ledgers with count
and byte ceilings. A result is acknowledged only after the broker retains a
bounded recovery copy; cache pressure keeps the durable extension outbox copy
for replay. Replayed or late confirmed results can recover a previously unknown
transport outcome, while a crash between a page effect and durable completion
remains explicitly unknown rather than being described as exactly-once. Event,
trace, screencast, and all-frame aggregation report consistent
`truncated`/`partial`/`complete` metadata. Large artifact handles are deferred;
existing tool schemas and base64 artifact responses remain compatible.
`networkBody` retains at most a 7 MiB result inside its 8 MiB durable
reservation and explicitly marks larger bodies as truncated and partial.

Session cleanup now uses `active` → `closing` → `closed` or
`cleanup_partial`. A failed tab removal preserves ownership so cleanup can be
retried. Restart reconciliation invalidates only provably stale temporary
metadata and never auto-closes adopted, user, created, handoff, or deliverable
tabs. Full automatic MCP-process death detection is deferred.

Anonymous timing telemetry is disabled by default. Tests and benchmarks can
enable it per client with `TABWARD_TELEMETRY=1`; each measured operation carries
its explicit opt-in to an already-running shared broker, so the broker does not
need a restart. Samples are available only as MCP `_meta["tabward/telemetry"]`
on `tabward_health`, so ordinary tool content and structured responses remain
unchanged.

The private beta intentionally uses this local command as its required
pre-push gate instead of GitHub Actions.

TabWard is licensed under [Apache-2.0](LICENSE).
