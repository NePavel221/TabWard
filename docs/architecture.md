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

Stage One adds a separate per-operation correlation UUID across MCP, broker
HTTP, bridge WebSocket, and extension results. Collection is off unless
the MCP client sets `TABWARD_TELEMETRY=1`. The client carries that choice on
each authenticated operation, so a persistent broker started by a non-opted-in
client does not require a restart. The closed numeric schema covers broker
active requests and commands ahead, bridge queue wait and round trip, extension
execution, outbox commit, residual transfer, broker/client total, result bytes,
and broker RSS. It does not collect URLs, DOM, locators, field values, file
paths, payload/result content, cookies, or arbitrary operation names. Opt-in
samples are exposed only in `tabward_health` MCP metadata, not ordinary
response content. Locator/CDP sub-stage timing is not implemented in Stage One.

The bridge intentionally retains one global `#commandTail`; concurrent clients
therefore execute extension commands sequentially. `npm run benchmark:stage1`
reproduces this head-of-line behavior with a synthetic WebSocket extension,
dynamic loopback ports, and a temporary state directory.

Persistent popup settings form an extension-enforced policy ceiling for
existing-tab access and workspace placement, so an MCP client cannot silently
override the user's choice. No TabWard cloud service receives browser content.

Managed sessions expose a bounded frontend QA layer through `tabward_form`,
`tabward_probe`, and `tabward_qa`. All locators resolve through the same
ownership-scoped locator engine. Composite QA snapshots and restores
pre-existing emulation, event capture, and CDP attachment state; Chrome
service-worker restart-safe metadata lives in `chrome.storage.session`.

Download IDs stored in `chrome.storage.session` carry their owning session ID.
List and delete operations filter by that owner, and legacy numeric/unowned
records fail closed. Download click/image workflows reserve one of the bounded
ownership slots before the browser side effect, atomically replace that
reservation with the resulting download ID, and roll it back after a confirmed
pre-download failure. Ambiguous post-click outcomes retain the reservation and
return the typed `OutcomeUnknown` extension error with only phase,
`actionAccepted`, `reservationHeld`, and `retrySafe` metadata rather than
encouraging a blind retry. Successful session release removes only that
session's downloads and reservations; it never evicts another session's
records. Default composite-QA screenshot artifacts include a safe session/run
suffix and use exclusive creation to avoid accidental overwrite.

Locator snapshots expose an explicit checkable state: `true`, `false`, `mixed`,
or unavailable. Checkbox/radio and supported ARIA checkable roles preserve
native indeterminate and `aria-checked="mixed"` states. Checked/unchecked waits
and assertions accept only explicit `true`/`false`; mixed and non-checkable
targets continue waiting and eventually use the existing timeout contract.

Clean QA adds a lease-backed `ready` → `active` → `tainted` state machine.
Before creating an incognito window it proves that no other incognito window
exists. Cleanup inventories the owned window before closing anything and
preserves the window if inventory or ownership cannot be confirmed.
