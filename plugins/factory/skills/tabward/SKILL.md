---
name: tabward
version: 0.4.0
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
5. Use `tabward_upload` with absolute local paths to attach files without
   opening the operating-system picker. It supports hidden file inputs. UNC,
   device, and network paths are rejected; an untrusted HTTPS host produces a
   popup approval that displays basenames only.
6. Use `tabward_form`, `tabward_probe`, and `tabward_qa` for repeatable
   frontend QA. Managed evaluate is allowed only on loopback pages.
7. Use `clean_qa: true` only for a requested fresh incognito context. It
   requires Chrome's **Allow in incognito** setting for TabWard and fails
   closed if other incognito state exists.
8. Use privileged evaluate, CDP, interception, or full-profile adoption only
   when the task requires them and user intent is clear. Browser-global,
   cross-target, cookie/auth, and unknown CDP commands require an exact
   one-time popup approval.
9. Always close the session. Preserve created tabs unless cleanup is requested.

## Post-task improvement check

After completing a task that actually used TabWard, check whether the task
exposed a high-leverage, reusable improvement to TabWard itself. Add a proposal
to the final response only when evidence from the completed task shows that the
improvement would:

- remove a substantial workaround or reduce several browser operations to one;
- prevent a repeatable failure, ambiguous outcome, or manual intervention; or
- materially improve safety, reliability, or diagnostics across future tasks.

Do not propose an improvement merely because the task was long, one action
failed once, a site lacked a convenient locator, or a cosmetic feature might
be useful. Exclude site-specific fixes and agent mistakes. If no strong
improvement exists, say nothing about this check.

When a strong improvement exists, add one compact block:

```text
Точка роста TabWard: <практический результат>
Проблема: <что затруднило выполненную задачу>
Предложение: <какой функционал добавить или изменить>
Эффект: <сейчас → после, с измеримым сокращением действий или риска>
Проверка: <как воспроизвести и подтвердить улучшение>
```

This is a proposal only. Do not modify TabWard unless the user explicitly
approves implementation. Keep the usual `Проверить точки роста: /growth`
reminder when the current global instructions require it.

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
