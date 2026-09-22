# HANDOFF

## Current Goal

Merge and push the live-validated private-beta security and public-readiness
hardening for TabWard `0.4.0` without publishing or changing repository
visibility.

## Current State

The `security/tabward-public-readiness-20260922` worktree now contains protocol
v3 mutual nonce/HMAC extension-broker authentication, bounded pre-auth
connections and pairing cooldown, target-frame-bound exact upload/CDP popup
approvals, exact-host-only upload trust, structured serialized-secret
redaction, opener-only child-tab correlation, authenticated transport
keepalive, complete command capability/expiry enforcement, hardened direct
broker validation, exact extension packaging, fail-closed all-history secret
and path scanning, exact dependency overrides, aligned protocol contracts, and
current `0.4.0` documentation. Composite `workflow` and `form` commands enforce
the capabilities required by every nested operation at both trust boundaries.
Approval requests remain active for five minutes, show an icon badge, and
disappear from every open popup when decided. Approved sensitive CDP results
still redact cookies and credentials before model-visible output.

Focused regressions, the complete 122-test suite, release packaging, source and
all-history secret scans, TypeScript checks, and the production dependency
audit pass. Hardened `0.4.0` is installed and live-validated: pairing/auth,
11 applicable frontend checks plus separate HTTPS upload checks, Clean QA 5/5,
four-session concurrency, 50/50 endurance with no leaked tabs, CDP
approve/deny/redaction, approval badge synchronization, and unknown/trusted
exact-host uploads all pass. No push, publish, visibility change, or history
rewrite has been performed.

## Last 7 Tasks

1. 2026-09-21: Added operation telemetry and isolated benchmarks.
2. 2026-09-21: Added deadlines, cancellation, durable result recovery, and byte budgets.
3. 2026-09-21: Hardened ownership, interleaving, and completeness behavior.
4. 2026-09-21: Added bounded fair concurrency and resource isolation.
5. 2026-09-22: Implemented the 0.4.0 security/public-readiness hardening set.
6. 2026-09-22: Closed the independent security review findings with deterministic regressions.
7. 2026-09-22: Installed 0.4.0 and passed the approved Chrome live gates.

## Next Step

Merge the security branch into `main`, run the required pre-push verification,
push to the private GitHub repository, and confirm that visibility remains
private. The sanitized 20-task real-use gate, public release, repository
visibility change, and package/store publishing remain separate decisions.

## Risks / Do Not Forget

- Same-OS-user malware remains outside the loopback/local-credential boundary.
- A crash between browser effect and durable result commit remains
  `OutcomeUnknown`.
- Do not claim public release or replacement readiness before the 20-task gate.
- Keep existing-tab access disabled by default.
- Never commit browser data, secrets, artifacts, logs, reports, or packages.
