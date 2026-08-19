# Contributing to TabWard

TabWard is currently a private Windows and Chrome beta. Repository access does
not grant access to another user's browser, pairing state, or local artifacts.

## Development setup

```powershell
git clone https://github.com/NePavel221/TabWard.git
Set-Location -LiteralPath '.\TabWard'
npm ci
npm run verify
```

Load `dist\extension` as an unpacked Chrome extension only when a browser smoke
test is required. Use test-created tabs and never close or modify unrelated
user tabs.

## Before opening a pull request

1. Keep browser transport bound to `127.0.0.1`.
2. Preserve managed-session ownership checks at both MCP and extension layers.
3. Do not commit pairing state, browser profiles, cookies, authenticated page
   content, downloads, artifacts, traces, logs, `.env` files, or credentials.
4. Keep extension, MCP, and plugin versions synchronized.
5. Run `npm run verify`.
6. Describe security or permission changes explicitly in the pull request.

Regenerate extension icons with `npm run icons` after changing the icon source
script.

## Reporting security issues

Do not place secrets, cookies, pairing tokens, or authenticated browser content
in an issue. Contact the repository owner privately until a dedicated
vulnerability-reporting channel is published.
