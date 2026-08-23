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

Compare both installed browser MCPs against the same local fixture:

```powershell
$env:TABWARD_COMPARE_CYCLES = '10'
npm run benchmark:browsers
```

The runner alternates execution order and requires TabWard pass rate, p50, and
p95 to be no worse than the legacy integration beyond the documented 10%
tolerance.

## Real-task gate

Complete 20 distinct local tasks without falling back to the legacy integration:

- at least five authenticated read scenarios;
- at least five multi-step scenarios;
- coverage of navigation, forms, child tabs, downloads, and lifecycle cleanup.

Record only task category, pass/fail, duration, and a sanitized defect
reference. Do not commit authenticated URLs, page content, screenshots,
cookies, storage, downloads, or user-generated data.

## Migration

After both gates pass, verify TabWard from the private GitHub snapshot, then
disable the legacy MCP and skill in Factory. Preserve its local files
until several further TabWard-only tasks have succeeded, so rollback remains
possible.
