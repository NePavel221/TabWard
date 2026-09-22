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
cloud upload. Cookies and authentication data are not added unless they were
explicitly part of the command result requested by the caller.

This document is a pre-release draft and must be reviewed before Chrome Web
Store submission.
