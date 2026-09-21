# Security model

- The WebSocket server listens only on `127.0.0.1`.
- The shared broker IPC also listens only on `127.0.0.1`, validates the exact
  Host header, and requires a random local bearer credential.
- A user must approve first-time pairing in the TabWard extension popup.
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
- Cookies remain inside Chrome; storage snapshots use opaque identifiers.
- Privileged JavaScript, existing-tab adoption, submissions, payments, account
  changes, and destructive actions require explicit user intent.
- Completed extension results remain in a bounded Chrome IndexedDB outbox only
  until acknowledged. Runtime diagnostics never log command or result payloads.
- Operation IDs and fingerprints deduplicate reconnects. A conflicting
  fingerprint is rejected, and an unknown post-dispatch outcome is never
  treated as proof of cancellation or completion.
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
  `cleanup_partial`; a closing session cannot accept new browser commands.
- Restart reconciliation never adopts an unproven debugger attachment and
  never auto-closes user, adopted, handoff, deliverable, or other tabs.
- Frame-targeted handles include frame/document identity. Nested-frame native
  input and element screenshots fail closed when CSS coordinate provenance
  cannot be verified.
- Composite QA restores caller-owned emulation, event capture, and CDP
  attachment state instead of unconditionally clearing it.
