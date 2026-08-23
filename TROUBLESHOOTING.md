# TROUBLESHOOTING

## PowerShell script corrupts Cyrillic project paths

- Symptom: a temporary `.ps1` resolves `Droid_Проекты` as mojibake and creates
  an incorrect directory.
- Cause: Windows PowerShell 5.1 reads UTF-8-without-BOM script literals as the
  active ANSI code page.
- Working method: keep temporary scripts ASCII-only and derive project paths
  from `$PSCommandPath` or the current repository path.
- Validation: the TabWard bootstrap copied files into the intended directory
  and the erroneous empty directory was removed.
- Applies to: Windows bootstrap and maintenance scripts.

## npm runs outside the TabWard project

- Symptom: npm reports that `package.json` does not exist or runs scripts from
  an unrelated parent project.
- Cause: every shell starts in the session workspace, not necessarily in the
  TabWard directory.
- Working method: use `Set-Location -LiteralPath '<TabWard>'` in the same
  command before npm operations.
- Validation: `npm run verify` completes in TabWard.

## Pairing code changes before approval

- Symptom: `tabward_health` prints a new six-digit code repeatedly and the
  popup remains in `Pairing required` after entering an earlier code.
- Cause: the extension sent WebSocket heartbeat messages while the connection
  was still unauthenticated, so the server closed it and created another
  pairing request.
- Working method: send heartbeat only in the `connected` state and retain one
  unexpired pairing code across reconnects.
- Validation: pairing integration and live Chrome smoke.

## Factory stores a broken Windows MCP path

- Symptom: `droid mcp list` reports that TabWard failed, and the saved argument
  looks like `C:Users...` without directory separators.
- Cause: `droid mcp add` treats backslashes in a command argument as escapes.
- Working method: replace backslashes with forward slashes before passing the
  absolute Node entry path to `droid mcp add`.
- Validation: the direct global Node entry and Factory MCP connection both
  complete an MCP handshake.
- Applies to: Windows Factory MCP registration.

## Factory cannot start a linked global MCP package

- Symptom: the direct Node entry works from the repository, while Factory
  reports that the globally installed TabWard MCP failed.
- Cause: `npm install --global .\packages\mcp` creates a directory junction
  back into the development repository instead of an independent package copy.
- Working method: run `npm run install:mcp`; it packs a temporary `.tgz`,
  installs that archive globally, and removes the temporary archive.
- Validation: `droid mcp list` reports `tabward stdio connected`.
- Applies to: local package installation before public npm publication.

## A second TabWard MCP closes or conflicts with the first

- Symptom: an older `0.1.x` installation reports `EADDRINUSE`, loses the
  extension connection, or a live smoke closes an existing MCP transport.
- Cause: each old stdio process owned the fixed extension WebSocket port.
- Working method: install `0.2.0` or newer. One on-demand `tabward-broker`
  owns ports `18766` and `18767`; all stdio MCP clients authenticate to and
  reuse that broker.
- Validation: the two-client stdio integration test receives the same broker
  instance ID from both clients.
- Applies to: concurrent Factory sessions and other MCP clients.

## Live gate sees broker but extension is not ready

- Symptom: health initially reports broker metadata with extension state
  `not_running` immediately after broker start or extension reload.
- Cause: the extension reconnects with bounded backoff and may not have reached
  the new broker before the first health call.
- Working method: wait up to 45 seconds for `connected`; fail immediately for
  `pairing_required` or `version_mismatch`. Do not treat the first
  `not_running` response as a permanent failure.
- Validation: the installed-package restart smoke starts a new broker and
  completes three browser cycles.
- Applies to: replacement gate and first MCP call after reload.

## Ephemeral MCP clients leave broker processes behind

- Symptom: repeated test runs leave many Node processes whose command line
  points to TabWard's broker.
- Cause: the SDK stdio transport may end through stdin EOF without emitting the
  close callback expected by the MCP entry point.
- Working method: treat stdin EOF as an explicit shutdown signal for ephemeral
  brokers and assert that test broker PIDs exit.
- Validation: stdio lifecycle tests pass and repeated gates leave only the one
  expected persistent broker.
- Applies to: MCP lifecycle tests and one-off clients.

## Deterministic extension error appears as OutcomeUnknown

- Symptom: an ordinary validation or ownership error is returned as HTTP 502
  and the client reports `OutcomeUnknown`.
- Cause: the broker did not distinguish typed extension business errors from
  ambiguous transport failures.
- Working method: preserve typed extension errors as HTTP 422; reserve 5xx and
  `OutcomeUnknown` for genuinely ambiguous transport/server failures.
- Validation: the real protocol-handshake regression returns the original
  error name and message.
- Applies to: broker/extension command boundary.

## QA viewport differs when Chrome zoom is not 100%

- Symptom: a requested viewport such as `393x852` is observed several CSS
  pixels larger when the origin has a saved Chrome zoom.
- Cause: CDP device metrics and Chrome's per-origin zoom are quantized
  independently.
- Working method: apply device metrics through a measured feedback loop,
  verify the resulting CSS viewport and DPR, and allow at most two CSS pixels
  of Chrome quantization. Roll back an unverified override.
- Validation: `npm run gate:qa` restores a pre-existing viewport and passes its
  mobile composite QA at 75% Chrome zoom.
- Applies to: emulation and composite QA.

## Composite QA clears caller-owned browser state

- Symptom: running `tabward_qa` removes emulation, event capture, or an existing
  CDP attachment configured before the QA call.
- Cause: cleanup unconditionally reset all QA resources.
- Working method: persist emulation metadata in `chrome.storage.session`,
  snapshot event/CDP ownership, and restore only the state acquired or replaced
  by the composite command.
- Validation: `npm run gate:qa` confirms that pre-existing viewport and console
  capture still work after composite QA.
- Applies to: `tabward_qa` cleanup and MV3 service-worker restarts.
