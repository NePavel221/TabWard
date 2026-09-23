# Replacement gate

TabWard replaces the legacy browser integration only after objective automated checks and local
real-task validation. A passing build alone is not sufficient.

## Automated gate

Run against the installed package and loaded Chrome extension:

```powershell
$env:TABWARD_GATE_GLOBAL = '1'
$env:TABWARD_GATE_CYCLES = '50'
node scripts\replacement-gate.mjs
```

The runner uses a local fixture, performs 50 complete open, observe, fill,
click, assert, and cleanup cycles, and writes a sanitized report under
`.factory/temp/`. Reports contain timings and error summaries only, never page
content, cookies, form values, or authenticated URLs.

Required result:

- all cycles pass;
- no session-owned tabs remain;
- no critical or high severity defects remain;
- `npm run verify` and `npm run audit:release` pass.

Run the Playwright-parity frontend gates as well:

```powershell
npm run gate:qa
npm run gate:clean-qa
```

`gate:qa` covers forms, probes, iframe observation, scoped screenshots,
console/network capture, dialogs, upload/download, drag/drop, history, trace,
loopback evaluate, and restoration of pre-existing emulation and events.
`gate:clean-qa` covers incognito preflight, concurrent-session rejection,
owned-window cleanup, and immediate clean restart. It requires
**Allow in incognito** for TabWard.

Compare both installed browser MCPs against the same local fixture:

```powershell
$env:TABWARD_COMPARE_CYCLES = '10'
npm run benchmark:browsers
```

The runner alternates execution order and requires TabWard pass rate, p50, and
p95 to be no worse than the legacy integration beyond the documented 10%
tolerance.

## Optional real-task gate

For additional confidence before replacing a legacy integration, complete 20
distinct local tasks without falling back to it:

- at least five authenticated read scenarios;
- at least five multi-step scenarios;
- coverage of navigation, forms, child tabs, downloads, and lifecycle cleanup.

Record only task category, pass/fail, duration, and a sanitized defect
reference. Do not commit authenticated URLs, page content, screenshots,
cookies, storage, downloads, or user-generated data.

## Migration

Do not treat public source access as approval to disable a working browser
integration. After the automated gates and sufficient local real-task
validation, verify TabWard from the GitHub source snapshot, then decide
whether to disable rollback integrations in Factory. Preserve their local
files until several further TabWard-only tasks have succeeded.
