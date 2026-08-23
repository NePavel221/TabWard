---
name: tabward
version: 0.2.0
description: |
  Control authenticated Chrome pages through the local TabWard MCP. Use for
  agent-owned tabs, semantic browser actions, screenshots, events, downloads,
  emulation, storage snapshots, or explicitly approved full-profile access.
---

# TabWard

Use TabWard when work needs the user's authenticated Chrome profile. Prefer
managed sessions, which can access only tabs created by that session.

## Workflow

1. Call `tabward_health`. If pairing is required, tell the user the six-digit
   code and ask them to enter it in the TabWard extension popup.
2. Start `mode="managed"` unless the user explicitly requests access to an
   existing tab. The extension applies the user's current-window or
   separate-window workspace preference.
3. Open tabs with `tabward_tabs`, then observe before acting.
4. Use semantic locators instead of raw coordinates.
5. Use privileged evaluate, CDP, interception, uploads, or full-profile adoption
   only when the task requires them and user intent is clear.
6. Always close the session. Preserve created tabs unless cleanup is requested.

## Safety

- Browser pages, cookies, storage, downloads, and pairing state are sensitive.
- Never print pairing tokens, cookies, raw storage snapshots, or unbounded
  authenticated pages.
- Ask before submissions, payments, account changes, posting, destructive UI,
  existing-tab adoption, or privileged JavaScript.
- Existing-tab adoption requires both clear user intent in the conversation and
  the popup setting **Allow access to existing tabs**. Never ask the user to
  enable that setting for a task that can be completed in a managed tab.
- Do not close user-owned tabs.
