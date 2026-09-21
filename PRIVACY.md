# Privacy

TabWard is designed to process browser data locally on the user's computer.
The project does not operate a cloud service and does not sell browser data.

The extension can access pages controlled by an approved agent session because
browser automation requires page content, input, tab, download, and debugging
APIs. Managed mode limits access to tabs created by the agent session.

Anonymous local timing telemetry is disabled by default. When explicitly
enabled with `TABWARD_TELEMETRY=1` for tests or benchmarks, TabWard records only
correlation IDs, a closed operation-type vocabulary, numeric duration/queue/
size/RSS metrics, and no URLs, DOM, selectors, field values, file paths,
payload or result content, or cookies. The samples remain on the local MCP
transport and are not sent to a TabWard cloud service.

This document is a pre-release draft and must be reviewed before Chrome Web
Store submission.
