# Security model

- The WebSocket server listens only on `127.0.0.1`.
- A user must approve first-time pairing in the TabWard extension popup.
- Pairing credentials stay in the local OS profile and are never MCP output.
- Managed mode exposes only tabs created by the current MCP session.
- Existing user tabs are hidden and blocked by the extension by default. The
  user can enable global existing-tab access in the popup for full-profile
  sessions and revoke it at any time without closing those tabs.
- The extension, not the MCP client, enforces whether new session tabs use the
  current-window TabWard group or a separate Chrome window.
- Sensitive page fields and URLs are redacted from bounded observations.
- Cookies remain inside Chrome; storage snapshots use opaque identifiers.
- Privileged JavaScript, existing-tab adoption, submissions, payments, account
  changes, and destructive actions require explicit user intent.
