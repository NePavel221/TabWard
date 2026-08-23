import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("extension uses paired WebSocket transport without native messaging", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  const manifest = JSON.parse(await readFile(
    resolve(root, "apps", "extension", "manifest.json"),
    "utf8"
  ));

  assert.match(background, /ws:\/\/127\.0\.0\.1:18766/);
  assert.match(background, /const PROTOCOL_VERSION = 2/);
  assert.match(background, /pairing_required/);
  assert.match(background, /result_ack/);
  assert.match(background, /resultOutbox/);
  assert.match(background, /indexedDB\.open/);
  assert.doesNotMatch(background, /message\.code.*pairingCode/);
  assert.doesNotMatch(background, /connectNative|nativeKeepalive|bridgeFetch|pollLoop/);
  assert.match(
    background,
    /transportState === "connected"[\s\S]*transportSocket\?\.readyState === WebSocket\.OPEN/
  );
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
  assert.equal(Number(manifest.minimum_chrome_version) >= 116, true);
});

test("site-created child tabs inherit their opener session", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  assert.match(background, /chrome\.tabs\.onCreated\.addListener/);
  assert.match(background, /openerTabId/);
  assert.match(background, /rememberTab\(ownedTab, "created-child", session\)/);
});

test("extension settings enforce existing-tab access and workspace placement", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  const popup = await readFile(
    resolve(root, "apps", "extension", "popup.html"),
    "utf8"
  );

  assert.match(background, /allowExistingTabs: false/);
  assert.match(background, /openInSeparateWindow: false/);
  assert.match(background, /payload\.sessionMode !== "full_profile"/);
  assert.match(background, /payload\.canAdoptExistingTabs !== true/);
  assert.match(background, /Access to existing user tabs is disabled/);
  assert.match(background, /getSessionWorkspace/);
  assert.match(background, /SESSION_POLICIES_KEY/);
  assert.match(background, /workspaceEnforcedBy: "extension_user_setting"/);
  assert.match(background, /releaseAdoptedTabs/);
  assert.match(popup, /id="allow-existing-tabs"/);
  assert.match(popup, /id="separate-window"/);
});

test("managed QA is ownership-scoped and Clean QA is fail-closed", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );

  assert.match(background, /MANAGED_QA|evaluateLocal|evaluate_local|localOnly|LocalEvaluateOnly/i);
  assert.match(background, /assertTabOwnership\(payload\.tabId, \{ createdOnly: true \}\)/);
  assert.match(background, /\["localhost", "127\.0\.0\.1", "\[::1\]"\]/);
  assert.match(background, /isAllowedIncognitoAccess/);
  assert.match(background, /incognito: true/);
  assert.match(background, /CleanQaTainted/);
  assert.match(background, /foreignTabsPreserved/);
  assert.match(background, /leaseExpiresAt/);
  assert.match(background, /Clean QA state was lost/);
  assert.match(background, /canCloseCreatedTabs/);
  assert.match(background, /inventoryVerified/);
  assert.match(background, /previousStateRestored/);
  assert.match(background, /preservedExistingAttachment/);
  assert.match(background, /cdpEventBrokers\.delete/);
  assert.match(background, /EMULATION_STATES_KEY/);
  assert.match(background, /setEmulationState/);
  assert.match(background, /EmulationVerificationError/);
  assert.match(background, /VIEWPORT_TOLERANCE_PX = 2/);
});

test("frontend QA handlers expose forms, probes, history, and scoped screenshots", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  assert.match(background, /form: commandForm/);
  assert.match(background, /probe: commandProbe/);
  assert.match(background, /qa: commandQa/);
  assert.match(background, /goBack:/);
  assert.match(background, /goForward:/);
  assert.match(background, /payload\.scope === "element"/);
  assert.match(background, /function resolveLocator\(locator\)/);
  assert.match(background, /const snapshot = await locatorSnapshot\(payload\.tabId, payload\.locator/);
  assert.match(background, /element\.checked = payload\.action === "check"/);
  assert.match(background, /did not reach the requested checkbox state/);
});

test("popup persists a Chrome-derived English or Russian language", async () => {
  const popupHtml = await readFile(
    resolve(root, "apps", "extension", "popup.html"),
    "utf8"
  );
  const popupJs = await readFile(
    resolve(root, "apps", "extension", "popup.js"),
    "utf8"
  );
  assert.match(popupHtml, /id="language"/);
  assert.match(popupHtml, /value="en"/);
  assert.match(popupHtml, /value="ru"/);
  assert.match(popupJs, /const LANGUAGE_KEY = "uiLanguage"/);
  assert.match(popupJs, /chrome\.i18n\.getUILanguage/);
  assert.match(popupJs, /chrome\.storage\.local\.set/);
  assert.match(popupJs, /document\.documentElement\.lang = language/);
  assert.match(popupJs, /ru: \{/);
});

test("locator waits reserve transport time after their browser deadline", async () => {
  const mcp = await readFile(
    resolve(root, "packages", "mcp", "src", "index.ts"),
    "utf8"
  );
  assert.match(
    mcp,
    /"locatorWait"[\s\S]*?timeoutMs: timeout_ms \+ 5_000/
  );
  assert.match(
    mcp,
    /"locatorAssert"[\s\S]*?timeoutMs: timeout_ms \+ 5_000/
  );
});

test("extension internals use the TabWard namespace", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  const content = await readFile(
    resolve(root, "apps", "extension", "content.js"),
    "utf8"
  );
  assert.match(background, /TABWARD_CURSOR_SET/);
  assert.match(content, /TABWARD_CURSOR_SET/);
  assert.doesNotMatch(`${background}\n${content}`, /DROID_|data-droid-|dataset\.droid/i);
});

test("private beta documentation and Factory skill are portable", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const installation = await readFile(
    resolve(root, "docs", "installation.md"),
    "utf8"
  );
  const skill = await readFile(
    resolve(root, "plugins", "factory", "skills", "tabward", "SKILL.md"),
    "utf8"
  );
  const marketplace = JSON.parse(await readFile(
    resolve(root, ".factory-plugin", "marketplace.json"),
    "utf8"
  ));

  assert.doesNotMatch(`${readme}\n${installation}`, /C:\\Users\\|DroidER|droider_/i);
  assert.match(readme, /npm run install:mcp/);
  assert.match(readme, /droid mcp add tabward node/);
  assert.match(skill, /tabward_health/);
  assert.match(skill, /mode="managed"/);
  assert.equal(marketplace.plugins[0].name, "tabward");
});
