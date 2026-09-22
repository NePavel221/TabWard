# Privacy

TabWard is designed to process browser data locally on the user's computer.
The project does not operate a cloud service and does not sell browser data.

The extension can access pages controlled by an approved agent session because
browser automation requires page content, input, tab, download, and debugging
APIs. Managed mode limits access to tabs created by the agent session.

Anonymous local timing telemetry is disabled by default. When explicitly
enabled with `TABWARD_TELEMETRY=1` for tests or benchmarks, TabWard records only
correlation IDs, a closed operation-type vocabulary, numeric duration/queue/
size/RSS metrics, scheduler active/queued/configured-maximum counts, and no
session names, URLs, DOM, selectors, field values, file paths, payload or result
content, or cookies. The samples remain on the local MCP transport and are not
sent to a TabWard cloud service.

Reliability state is also local and bounded. Its metadata contains operation
IDs, content fingerprints, deadlines, typed outcomes, byte/count accounting,
and truncation flags. To recover a completed operation after a transport loss,
the extension IndexedDB outbox and broker in-memory confirmation cache may
temporarily retain the full command result, including page-derived result
content requested by the caller. Both stores have byte/count ceilings. The
extension deletes an outbox result only after the broker confirms bounded
retention; the broker cache is process-memory only and is not telemetry or a
cloud upload. Cookie values, authorization headers, API keys,
access/refresh/ID tokens, and similar authentication material are structurally
redacted before network events, HAR, response bodies, web-storage diagnostics,
or ordinary CDP results are retained or returned. Sensitive raw
browser-global CDP remains available only through an exact one-time popup
approval.

Local-file uploads do not copy file contents into TabWard state. The MCP checks
that each absolute path is a readable local file; UNC, device, and network
paths are rejected. The extension shows only basenames in approval UI.
Automatic upload is limited to trusted exact HTTPS hosts. Wildcard trust is
rejected. Unknown hosts require an approve-once, trust-exact-host, or deny
decision bound to the operation, tab, target frame, document, host, and files
for at most five minutes. The target-frame origin/document is checked again
immediately before browser dispatch.
