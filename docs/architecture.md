# Architecture

```text
MCP clients -> TabWard stdio MCP -> authenticated IPC on 127.0.0.1
            -> persistent TabWard broker
            -> paired WebSocket on 127.0.0.1
            -> TabWard MV3 extension -> Chrome APIs and CDP
            -> agent-owned tabs in the real Chrome profile
```

Each MCP process owns its TTL-bound session policy and exposes typed tools. One
on-demand broker owns the extension WebSocket and is shared by concurrent MCP
clients. Runtime discovery uses an atomic local file and a separate bearer
credential; the pairing credential is never returned to MCP clients.

Protocol v2 assigns every broker request an idempotency key. The extension
stores completed results in a bounded IndexedDB outbox until the broker
acknowledges them. Read-only commands may be retried after a transport failure;
actions with an uncertain outcome return `OutcomeUnknown` and must be followed
by observation instead of a blind retry.

Persistent popup settings form an extension-enforced policy ceiling for
existing-tab access and workspace placement, so an MCP client cannot silently
override the user's choice. No TabWard cloud service receives browser content.

Managed sessions expose a bounded frontend QA layer through `tabward_form`,
`tabward_probe`, and `tabward_qa`. All locators resolve through the same
ownership-scoped locator engine. Composite QA snapshots and restores
pre-existing emulation, event capture, and CDP attachment state; Chrome
service-worker restart-safe metadata lives in `chrome.storage.session`.

Clean QA adds a lease-backed `ready` → `active` → `tainted` state machine.
Before creating an incognito window it proves that no other incognito window
exists. Cleanup inventories the owned window before closing anything and
preserves the window if inventory or ownership cannot be confirmed.
