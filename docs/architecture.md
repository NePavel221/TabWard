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

Protocol v2 assigns every operation one correlation ID, content fingerprint,
and absolute deadline. The same ID crosses MCP, authenticated broker HTTP,
the fair bridge scheduler, WebSocket dispatch, the extension operation context,
IndexedDB outbox, result, and acknowledgement. Queue wait consumes the same
deadline. Work that expires or is cancelled before dispatch returns a typed
`not_started`/`cancelled_before_effect` outcome and cannot touch Chrome.
Cancellation after dispatch aborts cooperative waits but remains
`effect_unknown` unless the handler can prove otherwise.

The broker operation ledger joins duplicate operation IDs with the same
fingerprint and rejects conflicting reuse. The extension reserves bounded
outbox count and bytes before dispatch, persists completed results, and replays
them after reconnect. A broker ACK is sent only after the full result fits the
bounded in-memory confirmation cache; otherwise `result_backpressure` leaves
the durable extension copy intact for a later replay. Late confirmed results
replace a settled `effect_unknown` ledger outcome with the matching result.
This supports recovery of confirmed results but does not claim exactly-once
execution: a crash between a page effect and durable completion is
`OutcomeUnknown`, and click, submit, upload, and download actions are not
blindly retried.

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

Stage Three uses a bounded fair scheduler instead of one global command tail.
Each session has a FIFO queue, and round-robin dispatch prevents a flooded
session from starving a sparse one. The configured maximum is bounded to
`1..4` and defaults to `2`; maximum `1` reproduces Stage Two ordering and
outcomes. Admission is bounded per session and in total, returning typed
pre-dispatch backpressure without browser effects. Global-exclusive work keeps
its origin session key, and the per-session bound counts queued plus active
work across both ordinary and global lanes.

Every command is classified before dispatch. Proven session-scoped commands
can overlap across sessions. All operations on the same tab serialize,
including reads whose document, locator, or CDP state could be invalidated by
navigation or mutation. Clean QA, session cleanup, profile-wide storage,
unknown scope, unknown expert CDP, and ambiguous download correlation run
globally exclusive: they wait for active work to drain and block later work
until completion. Legacy `executeCdp` and any command alias without a proven
resource classification are global-exclusive as well. Round-robin global
selection validates the exact candidate's sequence barrier: earlier ordinary
work and earlier globals from the same origin must run first, while a blocked
origin does not prevent another eligible origin from using the exclusive lane.
Session close marks the session closing synchronously,
rejects new commands, waits for already accepted session work, and then enters
global-exclusive cleanup.

The extension accepts concurrent WebSocket dispatches with immutable
operation-scoped contexts and a resource gate mirroring session/tab/global
isolation. IndexedDB transactions, serialized reservations, fingerprinted
ACKs, and the operation ledger prevent lost concurrent completion state and
duplicate browser dispatch. CDP mutation and cleanup are same-tab serialized.
Long-lived event, interception, emulation, trace, and screencast claims belong
to an exact operation; another operation in the same session receives
`CdpResourceBusy` rather than replacing the owner. Session cleanup detaches
only resources it owns and preserves foreign-session claims. A trace moves to
`stopping` after `Tracing.end`; timeout or cancellation retains that state,
retries can wait without restarting the trace, and the eventual
`Tracing.tracingComplete` event releases the claim. Composite QA snapshots and
restores resources it temporarily changes.
Correlation-sensitive download/new-tab workflows are exclusive when identity
cannot otherwise be proven rather than assigning by URL/referrer guesswork.

`npm run benchmark:stage3` runs the isolated 1/2/4 scheduler-by-client matrix
with dynamic loopback ports and temporary state. The final review rerun
measured four-client p95 total at `186.43 ms` for maximum `2`, versus the
Stage Two baseline `371.37 ms` (49.8% improvement). One-client p95 was
`111.45 ms` versus `93.19 ms` in that run; the matrix remains synthetic and
the live Chrome gate is still required. Maximum `4` reached `90.81 ms` at four
clients but remains tested rather than the initial production default.

Extension command handlers receive an immutable operation-scoped context
containing operation ID, session data, absolute deadline, and AbortSignal.
They no longer depend on shared mutable active-session or active-signal
globals. Nested ownership helpers receive that context explicitly; they do not
reconstruct the active session from legacy payload fields. A serialized
StateStore protects short `chrome.storage.session` read-modify-write mutations
for ownership, workspace/session metadata, download reservations, emulation,
Clean QA lease metadata, and CDP ownership metadata. Ownership updates after
Chrome I/O are key-scoped upserts/deletes against fresh state, not replacement
of an earlier snapshot. StateStore mutation callbacks cannot await Chrome,
CDP, network, screenshot, or wait operations.

Session lifecycle is `active` → `closing` → `closed` or `cleanup_partial`.
Closing sessions reject new commands and receive a five-minute cleanup TTL
pin, so cleanup can cross the original session expiry. Accepted ownership
mutations during closing do not touch or shorten that pin. Failed or
unverified tab removal preserves ownership and cleanup metadata for a later
retry. Expired
orphaned outbox reservations become durable `OutcomeUnknown` tombstones,
recovering reserved capacity without silently erasing ambiguity. Restart
reconciliation can invalidate stale temporary metadata without claiming an
unknown debugger attachment or closing any tab. Reliable automatic MCP-process
death detection and privilege reclamation beyond lease evidence are deferred
to the next lifecycle stage.

Events, traces, screencast frames, all-frame aggregates, broker cache, and
extension outbox have byte as well as count limits. Events, traces, screencast
frames, and frame aggregates add consistent `truncated`, `partial`, and
`complete` fields plus applicable dropped-count metadata. A retained child
frame with boolean or structured `truncated`, `outputTruncated`, or nested
incomplete evidence makes its aggregate partial. Network response bodies are
bounded to a 7 MiB result payload inside their 8 MiB durable reservation;
larger bodies return a deterministic truncated result with
`partial: true`/`complete: false` rather than failing during outbox commit.
Composite QA cannot report green when its evidence is partial. Existing base64
screenshot and JSON trace APIs remain unchanged. Handle-based large-artifact
transfer is deferred.

Frame-targeted scripting preserves frame and document identity. Document
replacement makes locator handles stale. Upload maps a marker created in the
requested frame back to a unique CDP backend node, so a matching selector in
the parent cannot be selected. Nested-frame locator actions use frame-local DOM
execution where safe; native operations and element screenshots fail closed
when a verified frame-to-top CSS coordinate chain is unavailable. Full OOPIF
coordinate-chain capture is deferred rather than guessed.

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
