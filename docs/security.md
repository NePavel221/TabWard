# Security model

- The WebSocket server listens only on `127.0.0.1`.
- The shared broker IPC also listens only on `127.0.0.1`, validates the exact
  Host header, and requires a random local bearer credential.
- The broker `/command` endpoint uses a strict command allowlist plus
  fail-closed payload, session, capability, depth, size, deadline, and upload
  validation. The extension remains the final browser policy authority.
- A user must approve first-time pairing in the TabWard extension popup.
- The extension and broker mutually authenticate with fresh nonces and HMAC.
  The reusable pairing token is never sent before broker proof. Pre-auth
  sockets have a small payload cap, handshake timeout, bounded connection and
  message counts, and cannot mutate authenticated bridge state. Five failed
  pairing attempts trigger a reconnect-resistant 30-second cooldown and code
  rotation.
- Pairing credentials stay in the local OS profile and are never MCP output.
- Broker runtime discovery and extension pairing use different credentials.
- Managed mode exposes only tabs created by the current MCP session.
- Managed JavaScript evaluation is restricted to `localhost`, `127.0.0.1`,
  and `[::1]`; arbitrary-page evaluate requires explicitly privileged
  full-profile mode.
- Clean QA requires Chrome's **Allow in incognito** setting for TabWard,
  refuses to start while another incognito window exists, and uses persisted
  leases and repeated ownership validation. Cleanup fails closed if the
  incognito tab inventory cannot be verified.
- Existing user tabs are hidden and blocked by the extension by default. The
  user can enable global existing-tab access in the popup for full-profile
  sessions and revoke it at any time without closing those tabs.
- The extension, not the MCP client, enforces whether new session tabs use the
  current-window TabWard group or a separate Chrome window.
- Sensitive page fields and URLs are redacted from bounded observations.
- Cookie, authorization, API-key, access/refresh/ID-token, and related secrets
  are structurally redacted before network event, HAR, response-body, storage,
  and ordinary CDP retention/return, including nested header arrays and mixed
  casing.
- Local uploads accept readable absolute local files but reject UNC, device,
  and network paths. Automatic dispatch is limited to trusted exact HTTPS
  hosts; wildcard trust is rejected. Unknown hosts require an exact popup
  decision bound to operation, session, tab, target frame, document, host, and
  file set for at most five minutes. The target-frame origin/document is checked
  again immediately before browser dispatch; navigation and service-worker
  restart invalidate approval.
- Every broker and extension command has an explicit capability policy.
  Session-bound commands reject incomplete, forged, or expired session
  context at both boundaries.
- Ordinary CDP remains tab-scoped. Browser-global, cross-target, cookie/auth,
  and unknown CDP commands require a fresh exact popup approval; there is no
  session-wide allow.
- Cookies remain inside Chrome; storage snapshots use opaque identifiers.
- Privileged JavaScript, existing-tab adoption, submissions, payments, account
  changes, and destructive actions require explicit user intent.
- Completed extension results remain in a bounded Chrome IndexedDB outbox only
  until acknowledged. Runtime diagnostics never log command or result payloads.
- Operation IDs and fingerprints deduplicate reconnects. A conflicting
  fingerprint is rejected, and an unknown post-dispatch outcome is never
  treated as proof of cancellation or completion.
- The broker scheduler is bounded to `1..4` active commands, defaults to `2`,
  preserves FIFO per session, and applies count backpressure before extension
  dispatch. Global-exclusive work retains its origin session, and queued plus
  active work share the same per-session bound. Compatibility maximum `1`
  preserves Stage Two ordering.
- Same-tab reads and mutations serialize. Clean QA, cleanup, profile storage,
  unknown command scope, expert CDP without a proven safe classification, and
  download correlation are globally exclusive. A child tab is adopted only
  when Chrome reports the owned source tab as its exact `openerTabId`;
  opener-less proximity or active-tab heuristics are not accepted.
- Legacy `executeCdp` and unknown aliases default to global-exclusive rather
  than receiving an optimistic tab/session classification.
- Global round-robin validates the exact selected item's barrier. It cannot
  use an older item's eligibility to skip earlier session work or a prior
  global from the same origin, and it scans other origins when one is blocked.
- CDP resource claims are operation-exact. Duplicate starts from another
  operation, including the same session, fail busy and cannot release the
  original claim. Trace stop retains a fail-closed `stopping` claim until
  Chrome confirms completion.
- Cleanup detaches only CDP resources attributable to the closing session and
  preserves event, trace, interception, screencast, or emulation ownership
  belonging to another session.
- A closing session rejects new work, waits for work already accepted by that
  MCP process, and then cleans up. Cleanup still closes only proven
  session-created tabs; adopted and user tabs are preserved.
- The outbox and broker ledger reserve count and byte capacity before browser
  dispatch. Event, trace, screencast, and aggregate evidence expose partial or
  truncated status instead of silently dropping data.
- Network response bodies are deterministically bounded to a 7 MiB result
  inside an 8 MiB durable reservation. Larger bodies are marked truncated and
  partial before outbox commit.
- Nested ownership checks consume immutable operation/session context
  explicitly. Ownership changes after browser I/O use fresh serialized
  key-level mutations so concurrent tab additions are not overwritten.
- Session cleanup preserves ownership after a failed tab close and reports
  `cleanup_partial`; a closing session cannot accept new browser commands, and
  accepted ownership mutations cannot shorten its cleanup TTL pin.
- Restart reconciliation never adopts an unproven debugger attachment and
  never auto-closes user, adopted, handoff, deliverable, or other tabs.
- Frame-targeted handles include frame/document identity. Nested-frame native
  input and element screenshots fail closed when CSS coordinate provenance
  cannot be verified.
- Composite QA restores caller-owned emulation, event capture, and CDP
  attachment state instead of unconditionally clearing it.

The same-OS-user trust boundary is explicit: loopback binding and local
credentials do not defend against malware or another process already able to
read the user's TabWard state, inject into Chrome, or tamper with the user
profile.
