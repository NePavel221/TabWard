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

## Node 24 syntax check rejects JavaScript through an uppercase short path

- Symptom: `node --check apps/extension/background.js` fails on Windows with
  `ERR_UNKNOWN_FILE_EXTENSION` and reports the resolved 8.3 path ending in
  uppercase `.JS`.
- Cause: Node 24's ESM syntax-check path classifies the uppercase short-path
  extension before parsing the source.
- Working method: compile the text without executing it:
  `node -e "new Function(require('fs').readFileSync(process.argv[1], 'utf8'))" <absolute-file>`.
- Validation: both `background.js` and `stage-two.js` compile successfully.
- Applies to: local extension JavaScript syntax checks on this Windows setup.

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

## MCP installer reports success but global version stays old

- Symptom: `npm run install:mcp` reports the new version, while
  `npm list --global @tabward/mcp --depth=0` still shows the old version.
- Cause: invoking the script through `npm --prefix <repo>` exports
  `npm_config_prefix=<repo>`. Child `npm install --global` inherits it and
  installs into the workspace instead of the user's real global prefix.
- Working method: remove inherited `npm_config_prefix` for the installer's
  internal npm calls, resolve `npm root --global`, then verify the installed
  manifest version and server entry before reporting success.
- Validation: global npm reports the requested TabWard version and the printed
  server path is under the user's global npm root.
- Applies to: `npm run install:mcp` on Windows.

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

- Symptom: running `tabward_qa` either reports a same-session CDP resource as
  busy or removes emulation, event capture, or an existing CDP attachment
  configured before the QA call.
- Cause: composite QA initially treated a resource owned by an earlier
  operation in the same session as foreign, and cleanup unconditionally reset
  QA resources.
- Working method: persist emulation metadata in `chrome.storage.session`,
  temporarily suspend same-session ownership, snapshot event/CDP ownership,
  and restore only the state acquired or replaced by the composite command.
- Validation: `npm run gate:qa` confirms that pre-existing viewport and console
  capture still work after composite QA.
- Applies to: `tabward_qa` cleanup and MV3 service-worker restarts.

## Popup approval expires before a person can act

- Symptom: an upload or sensitive CDP command becomes `OutcomeUnknown` before
  the user can approve or deny the popup request.
- Cause: the public MCP command deadline was shorter than the human approval
  window.
- Working method: keep approval requests active for five minutes, give
  `tabward_upload` and `tabward_cdp` six-minute default deadlines, show the
  active request count on the extension icon, and synchronize decisions across
  all open popup views.
- Validation: live CDP deny and approve gates return deterministic outcomes;
  the icon shows `1` while pending and all popup blocks disappear after one
  decision.
- Applies to: human-approved uploads and browser-global CDP.

## Chrome Reload keeps showing the old extension version

- Symptom: the repository and packaged extension show a new version, but
  `chrome://extensions` still shows the old version after clicking Reload.
- Cause: Reload restarts the extension from its previously selected source
  directory. It does not switch Chrome to another repository or `dist` folder.
- Working method: remove only the old TabWard extension card, select
  **Load unpacked**, and choose the verified `dist/extension` directory. Pair
  the new extension again if Chrome assigns a new extension ID.
- Historical validation for the older build: Chrome showed version `0.3.1`,
  health reported extension version `0.3.1`, and `npm run gate:qa` passed
  12/12 including hidden file upload.
- Applies to: switching local unpacked TabWard builds.

## Hidden file input cannot receive an upload

- Symptom: attaching a file fails with `Locator matched 0 visible elements`
  even though the page has an attachment button.
- Cause: custom upload buttons commonly wrap a hidden `input[type=file]`, while
  the generic actionable locator previously required every target to be
  visible.
- Working method: use `tabward_upload`. Upload resolution allows hidden file
  inputs, validates each absolute local path before browser interaction, and
  calls CDP `DOM.setFileInputFiles` without opening the operating-system picker.
- Validation: the frontend QA fixture uses a hidden file input and confirms the
  attached filename; the full gate passes 12/12.
- Applies to: court portals and other sites with custom attachment controls.

## Security-fixed transitive versions do not enter the lockfile

- Symptom: root `overrides` are present, but `npm audit --omit=dev` still
  reports the previous `fast-uri`, `hono`, or `qs` version.
- Cause: a normal `npm install` can leave already-resolved transitive entries
  unchanged in the existing lockfile.
- Working method: run
  `npm update fast-uri hono qs --ignore-scripts`, then verify `npm ls` and
  `npm audit --omit=dev`.
- Validation: the lockfile resolves `fast-uri` 3.1.8, `hono` 4.13.8, and
  `qs` 6.16.0 with zero production vulnerabilities.
- Applies to: 0.4.0 dependency remediation.
