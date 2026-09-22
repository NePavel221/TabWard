import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import vm from "node:vm";
import {
  releasePathViolations,
  secretRuleMatches
} from "../../../scripts/release-rules.mjs";

const root = resolve(import.meta.dirname, "..", "..", "..");

async function stageOneHelpers() {
  const source = await readFile(
    resolve(root, "apps", "extension", "stage-one.js"),
    "utf8"
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.TabWardStageOne;
}

async function stageTwoHelpers() {
  const source = await readFile(
    resolve(root, "apps", "extension", "stage-two.js"),
    "utf8"
  );
  const context = vm.createContext({ structuredClone, TextEncoder });
  vm.runInContext(source, context);
  return context.TabWardStageTwo;
}

async function stageThreeHelpers() {
  const source = await readFile(
    resolve(root, "apps", "extension", "stage-three.js"),
    "utf8"
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.TabWardStageThree;
}

async function securityHelpers() {
  const source = await readFile(
    resolve(root, "apps", "extension", "security.js"),
    "utf8"
  );
  const context = vm.createContext({
    atob,
    btoa,
    crypto,
    TextEncoder,
    URL
  });
  vm.runInContext(source, context);
  return context.TabWardSecurity;
}

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
  assert.match(background, /const PROTOCOL_VERSION = 3/);
  assert.match(background, /pairing_required/);
  assert.match(background, /result_ack/);
  assert.match(background, /resultOutbox/);
  assert.match(background, /importScripts\("security\.js", "stage-one\.js", "stage-two\.js", "stage-three\.js"\)/);
  assert.match(background, /indexedDB\.open/);
  assert.match(background, /deadlineAt/);
  assert.match(background, /activeOperations/);
  assert.equal(
    background.indexOf("await outboxPut(envelope)")
      < background.indexOf("activeOperations.delete(operation.operationId)"),
    true
  );
  assert.doesNotMatch(background, /activeSessionContext|activeCommandSignal/);
  assert.doesNotMatch(background, /message\.code.*pairingCode/);
  assert.doesNotMatch(background, /connectNative|nativeKeepalive|bridgeFetch|pollLoop/);
  assert.match(background, /function sendTransportPing\(socket = transportSocket\)/);
  assert.match(background, /transportState !== "connected"/);
  assert.match(background, /socket\?\.readyState !== WebSocket\.OPEN/);
  assert.match(background, /const TRANSPORT_KEEPALIVE_MS = 20_000/);
  assert.match(background, /setInterval\([\s\S]*sendTransportPing\(socket\)/);
  assert.match(background, /clearInterval\(transportKeepaliveTimer\)/);
  assert.match(background, /chrome\.alarms\.onAlarm[\s\S]*sendTransportPing\(\)/);
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
  assert.equal(Number(manifest.minimum_chrome_version) >= 116, true);
});

test("security helpers redact nested credentials, classify CDP, and bind approvals", async () => {
  const helpers = await securityHelpers();
  const redacted = helpers.redactBrowserPayload({
    headers: [
      { name: "AuThOrIzAtIoN", value: "x" },
      ["Set-Cookie", "a=b"],
      { key: "x-api-key", value: "z" },
      { name: "safe", value: "ok" }
    ],
    access_token: "a",
    nested: { refreshToken: "b", idToken: "c", token: "d" },
    text: "Bearer short",
    serialized: "{\"password\":\"hunter2\",\"credentials\":\"secret\",\"safe\":\"normal\"}; access_token=abc123; token=short",
    cookieHeader: "Cookie: sid=secret; csrf=more",
    prose: "A password manager improves normal account security."
  });
  assert.deepEqual(JSON.parse(JSON.stringify(redacted)), {
    headers: [
      { name: "AuThOrIzAtIoN", value: "[REDACTED]" },
      ["Set-Cookie", "[REDACTED]"],
      { key: "x-api-key", value: "[REDACTED]" },
      { name: "safe", value: "ok" }
    ],
    access_token: "[REDACTED]",
    nested: {
      refreshToken: "[REDACTED]",
      idToken: "[REDACTED]",
      token: "[REDACTED]"
    },
    text: "Bearer [REDACTED]",
    serialized: "{\"password\":\"[REDACTED]\",\"credentials\":\"[REDACTED]\",\"safe\":\"normal\"}; access_token=\"[REDACTED]\"; token=\"[REDACTED]\"",
    cookieHeader: "Cookie: [REDACTED]",
    prose: "A password manager improves normal account security."
  });
  assert.equal(helpers.classifyCdp("Runtime.evaluate", {}).approvalRequired, false);
  assert.equal(helpers.classifyCdp("Storage.getCookies", {}).approvalRequired, true);
  assert.equal(helpers.classifyCdp("Runtime.evaluate", {
    sessionId: "foreign"
  }).approvalRequired, true);
  assert.equal(helpers.classifyCdp("Future.read", {}).approvalRequired, true);
  const binding = {
    approvalId: "approval",
    kind: "cdp",
    operationId: "operation",
    fingerprint: "f".repeat(64),
    sessionId: "session",
    tabId: 1,
    documentId: "document",
    origin: "https://example.test",
    host: null,
    method: "Storage.getCookies",
    paramsFingerprint: "p".repeat(64),
    fileFingerprint: null,
    workerInstanceId: "worker",
    status: "approved",
    expiresAt: Date.now() + 10_000
  };
  assert.equal(helpers.approvalMatches(binding, binding), true);
  assert.equal(helpers.approvalMatches(binding, {
    ...binding,
    method: "Storage.clearDataForOrigin"
  }), false);
  assert.equal(helpers.approvalMatches(binding, {
    ...binding,
    operationId: "replay"
  }), false);
  assert.equal(helpers.approvalMatches(binding, {
    ...binding,
    documentId: "navigated"
  }), false);
  assert.doesNotThrow(() =>
    helpers.assertEffectAuthorizationFresh(Date.now() + 10_000)
  );
  assert.throws(
    () => helpers.assertEffectAuthorizationFresh(Date.now() - 1),
    /expired before dispatch/
  );
});

test("upload trust requires an exact HTTPS host and child tabs require opener provenance", async () => {
  const helpers = await securityHelpers();
  assert.equal(
    helpers.classifyUploadUrl(
      "https://files.example.com/upload",
      ["files.example.com"]
    ).trusted,
    true
  );
  assert.equal(
    helpers.classifyUploadUrl(
      "https://other.example.com/upload",
      ["files.example.com"]
    ).trusted,
    false
  );
  assert.throws(
    () => helpers.classifyUploadUrl("http://files.example.com/upload", []),
    /HTTPS/
  );
  assert.throws(() => helpers.normalizeTrustedPattern("*.example.com"), /not allowed/);
  const source = { id: 1, windowId: 2, active: true, index: 4 };
  assert.equal(helpers.correlateCreatedTab({
    id: 3, openerTabId: 1, windowId: 9, active: false, index: 0
  }, source, []), true);
  assert.equal(helpers.correlateCreatedTab({
    id: 4, windowId: 2, active: true, index: 5
  }, source, []), false);
  assert.equal(helpers.correlateCreatedTab({
    id: 5, windowId: 2, active: true, index: 1
  }, source, []), false);
});

test("upload authorization binds the target frame document and rechecks at the effect boundary", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  assert.match(
    background,
    /async function frameDocumentIdentity[\s\S]*location\.href[\s\S]*location\.origin/
  );
  assert.match(
    background,
    /revalidateUploadAuthorization[\s\S]*assertEffectAuthorizationFresh\(authorization\.expiresAt\)/
  );
  assert.match(
    background,
    /commandExecuteCdp[\s\S]*throwIfCommandAborted\(payload\)[\s\S]*assertEffectAuthorizationFresh\(approval\.expiresAt\)[\s\S]*cdpSend/
  );
  assert.match(
    background,
    /commandExecuteCdp[\s\S]*result:\s*sanitizeBrowserPayload\(result\)/
  );
  assert.doesNotMatch(
    background,
    /commandExecuteCdp[\s\S]{0,1000}approvalRequired\s*\?\s*result/
  );
  assert.doesNotMatch(background, /sessionName: context\.session\?\.name/);
  const popup = await readFile(
    resolve(root, "apps", "extension", "popup.js"),
    "utf8"
  );
  assert.match(popup, /currentApproval\.sessionLabel/);
  assert.doesNotMatch(popup, /currentApproval\.sessionName/);
  assert.match(background, /const APPROVAL_TTL_MS = 5 \* 60_000/);
  assert.match(background, /const APPROVAL_HISTORY_LIMIT = 20/);
  assert.match(background, /chrome\.action\.setBadgeText/);
  assert.match(background, /approval\?\.actionable === true/);
  assert.match(background, /status:\s*Number\(record\.expiresAt \|\| 0\) <= Date\.now\(\)[\s\S]*"expired"[\s\S]*"cancelled"/);
  assert.match(popup, /currentApproval\.actionable !== true/);
  assert.match(popup, /find\(\(approval\) => approval\.actionable === true\)/);
  assert.match(popup, /chrome\.storage\.onChanged\.addListener/);
  assert.match(
    background,
    /async function authorizeUpload[\s\S]*frameDocumentIdentity\([\s\S]*identity\.origin/
  );
  assert.match(
    background,
    /async function cdpSetInputFiles[\s\S]*await revalidateUploadAuthorization\(uploadAuthorization\)[\s\S]*DOM\.setFileInputFiles/
  );
  assert.doesNotMatch(
    background,
    /async function authorizeUpload[\s\S]{0,500}chrome\.tabs\.get\(payload\.tabId\)/
  );
});

test("extension capability policy covers every handler and rejects expired sessions", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  const policyBody = background.match(
    /const COMMAND_CAPABILITY_POLICY = Object\.freeze\(\{([\s\S]*?)\n\}\);/
  )?.[1] || "";
  const handlersBody = background.match(
    /const handlers = \{([\s\S]*?)\r?\n\};\r?\n\r?\nfunction commandCapabilities/
  )?.[1] || "";
  const keys = (body) => new Set(
    [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)]
      .map((match) => match[1])
  );
  assert.deepEqual([...keys(policyBody)].sort(), [...keys(handlersBody)].sort());
  assert.match(background, /commandCapabilities\(type, payload, context\.session\)/);
  assert.match(background, /type === "locatorAction" && payload\.action === "upload"/);
  assert.match(background, /type === "qa"[\s\S]*capabilities\.push\("emulation"\)/);
  assert.match(
    background,
    /type === "workflow"[\s\S]*WORKFLOW_STEP_CAPABILITY_POLICY\[step\.type\][\s\S]*capabilities\.push\(\.\.\.required\)/
  );
  assert.match(
    background,
    /type === "form"[\s\S]*FORM_FIELD_CAPABILITY_POLICY\[field\.action\][\s\S]*capabilities\.push\(\.\.\.required\)/
  );
  assert.match(background, /TabWardStageTwo\.sessionExpiresAtValid\(session\.expiresAt\)/);

  const helpers = await stageTwoHelpers();
  assert.equal(helpers.sessionExpiresAtValid(101, 100), true);
  assert.equal(helpers.sessionExpiresAtValid(100, 100), false);
  assert.equal(helpers.sessionExpiresAtValid(Number.NaN, 100), false);
});

test("release rules scan NUL-containing content and reject forbidden historical paths", () => {
  assert.deepEqual(
    secretRuleMatches(Buffer.from("prefix\u0000npm_abcdefghijklmnopqrstuvwxyz1234567890suffix")),
    ["npm-token"]
  );
  assert.deepEqual(
    releasePathViolations("archive/profiles/user/state.json"),
    ["forbidden release directory"]
  );
  assert.deepEqual(
    releasePathViolations("archive/export.zip"),
    ["forbidden release file extension"]
  );
});

test("Stage Three extension gate serializes same-session and same-tab work", async () => {
  const helpers = await stageThreeHelpers();
  const gate = helpers.createResourceGate();
  const active = new Set();
  let overlap = false;
  const run = (command, delay = 10) => {
    const scope = helpers.classifyCommand(command);
    return gate.run(scope, async () => {
      for (const resource of scope.resources) {
        if (active.has(resource)) overlap = true;
        active.add(resource);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      for (const resource of scope.resources) active.delete(resource);
    });
  };
  await Promise.all([
    run({ type: "getText", payload: { sessionId: "a", tabId: 1 } }),
    run({ type: "navigate", payload: { sessionId: "a", tabId: 2 } }),
    run({ type: "getText", payload: { sessionId: "b", tabId: 1 } })
  ]);
  assert.equal(overlap, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(gate.metrics())),
    { active: 0, queued: 0, globalActive: false, resources: 0 }
  );
});

test("Stage Three extension gate makes Clean QA and ambiguous correlations global", async () => {
  const helpers = await stageThreeHelpers();
  assert.equal(helpers.classifyCommand({
    type: "nameSession",
    payload: { sessionId: "clean", cleanQa: true }
  }).global, true);
  assert.equal(helpers.classifyCommand({
    type: "downloadClick",
    payload: { sessionId: "a", tabId: 1 }
  }).global, true);
  assert.equal(helpers.classifyCommand({
    type: "cdp",
    payload: { sessionId: "a", tabId: 1, method: "Unknown.enable" }
  }).global, true);

  const gate = helpers.createResourceGate();
  let active = 0;
  let maxActive = 0;
  const clean = (sessionId) => gate.run(helpers.classifyCommand({
    type: "nameSession",
    payload: { sessionId, cleanQa: true }
  }), async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    active -= 1;
  });
  await Promise.all([clean("clean-a"), clean("clean-b")]);
  assert.equal(maxActive, 1);
});

test("four download correlations and shared CDP tab resources never overlap", async () => {
  const helpers = await stageThreeHelpers();
  const gate = helpers.createResourceGate();
  let activeDownloads = 0;
  let maxDownloads = 0;
  await Promise.all(Array.from({ length: 4 }, (_, index) =>
    gate.run(helpers.classifyCommand({
      type: "downloadClick",
      payload: {
        sessionId: `session-${index}`,
        tabId: index + 1,
        url: "https://same.example/file"
      }
    }), async () => {
      activeDownloads += 1;
      maxDownloads = Math.max(maxDownloads, activeDownloads);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3));
      activeDownloads -= 1;
    })
  ));
  assert.equal(maxDownloads, 1);

  const cdpGate = helpers.createResourceGate();
  let cdpActive = 0;
  let cdpOverlap = false;
  const cdp = (type) => cdpGate.run(helpers.classifyCommand({
    type,
    payload: { sessionId: "session-a", tabId: 42 }
  }), async () => {
    cdpActive += 1;
    if (cdpActive > 1) cdpOverlap = true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3));
    cdpActive -= 1;
  });
  await Promise.all([cdp("eventsStart"), cdp("eventsStop")]);
  assert.equal(cdpOverlap, false);
});

test("CDP claims are idempotent only for the exact operation", async () => {
  const helpers = await stageThreeHelpers();
  for (const resource of ["events", "interception", "tracing"]) {
    const owners = new Map();
    const first = { operationId: "operation-a", sessionId: "session-a" };
    const second = { operationId: "operation-b", sessionId: "session-a" };
    assert.equal(helpers.claimResource(owners, resource, first).created, true);
    assert.equal(helpers.claimResource(owners, resource, first).created, false);
    assert.throws(
      () => helpers.claimResource(owners, resource, second),
      (error) => error?.name === "CdpResourceBusy"
    );
    assert.throws(
      () => helpers.releaseResource(owners, resource, second),
      (error) => error?.name === "CdpResourceBusy"
    );
    assert.equal(owners.get(resource).operationId, first.operationId);
    assert.equal(helpers.releaseResource(owners, resource, first), true);
    assert.equal(owners.has(resource), false);
  }
});

test("trace stopping survives timeout or cancel until late completion", async () => {
  const helpers = await stageThreeHelpers();
  const owners = new Map();
  const start = { operationId: "trace-start", sessionId: "session-a" };
  const stop = { operationId: "trace-stop", sessionId: "session-a" };
  helpers.claimResource(owners, "tracing", start);
  const stopping = helpers.transitionResource(
    owners,
    "tracing",
    stop,
    "stopping"
  );
  assert.equal(stopping.previousState, "active");
  assert.equal(owners.get("tracing").state, "stopping");
  assert.throws(
    () => helpers.claimResource(
      owners,
      "tracing",
      { operationId: "premature-start", sessionId: "session-a" }
    ),
    (error) => error?.name === "CdpResourceBusy"
  );
  const retry = helpers.transitionResource(
    owners,
    "tracing",
    { operationId: "trace-stop-retry", sessionId: "session-a" },
    "stopping"
  );
  assert.equal(retry.previousState, "stopping");
  assert.equal(helpers.completeStoppingResource(owners, "tracing"), true);
  assert.equal(owners.has("tracing"), false);
  assert.equal(helpers.claimResource(
    owners,
    "tracing",
    { operationId: "next-start", sessionId: "session-a" }
  ).created, true);
});

test("session cleanup preserves foreign CDP resources", async () => {
  const helpers = await stageThreeHelpers();
  const resources = [
    {
      tabId: 1,
      attachmentSessionId: "session-a",
      tabSessionId: "session-a",
      owners: [{ sessionId: "session-a", operationId: "a-events" }]
    },
    {
      tabId: 2,
      attachmentSessionId: "session-b",
      tabSessionId: "session-b",
      owners: [{ sessionId: "session-b", operationId: "b-trace" }]
    },
    {
      tabId: 3,
      attachmentSessionId: "session-a",
      tabSessionId: "session-a",
      owners: [
        { sessionId: "session-a", operationId: "a-events" },
        { sessionId: "session-b", operationId: "b-screencast" }
      ]
    }
  ];
  const decisions = resources.map((resource) =>
    helpers.sessionDetachDecision(resource, "session-a"));
  assert.deepEqual(
    decisions.map((value) => JSON.parse(JSON.stringify(value))),
    [
      { belongs: true, detach: true, foreignOwners: 0 },
      { belongs: false, detach: false, foreignOwners: 1 },
      { belongs: true, detach: false, foreignOwners: 1 }
    ]
  );
});

test("legacy and unknown CDP aliases remain global exclusive", async () => {
  const helpers = await stageThreeHelpers();
  for (const type of ["executeCdp", "futureUnknownCommand"]) {
    const scope = helpers.classifyCommand({
      type,
      payload: { sessionId: "session-a", tabId: 42 }
    });
    assert.equal(scope.global, true, type);
    assert.equal(scope.sessionKey, "session-a", type);
  }
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
  assert.match(
    background,
    /hasOwnProperty\.call\(patch, "existingTabAccess"\)[\s\S]*normalizedPatch\.allowExistingTabs = patch\.existingTabAccess === true/
  );
  assert.match(
    background,
    /Full Profile requires the user to enable existing-tab access/
  );
  assert.match(popup, /id="allow-existing-tabs"/);
  assert.match(popup, /id="separate-window"/);
});

test("MCP queries the human full-profile toggle before creating a session", async () => {
  const mcp = await readFile(
    resolve(root, "packages", "mcp", "src", "index.ts"),
    "utf8"
  );
  assert.match(
    mcp,
    /mode === "full_profile"[\s\S]*bridge\.send\(\s*"getUserSettings"/
  );
  assert.match(
    mcp,
    /settings\.settings\?\.existingTabAccess !== true/
  );
  assert.equal(
    mcp.indexOf('bridge.send(\n      "getUserSettings"')
      < mcp.indexOf("const session = sessions.start"),
    true
  );
});

test("managed QA is ownership-scoped and Clean QA is fail-closed", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );

  assert.match(background, /MANAGED_QA|evaluateLocal|evaluate_local|localOnly|LocalEvaluateOnly/i);
  assert.match(
    background,
    /assertTabOwnership\(payload\.tabId, \{ context: payload, createdOnly: true \}\)/
  );
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
  assert.match(
    background,
    /function commandQa[\s\S]*const suspendOwnedResources = \(resources\) =>[\s\S]*for \(const resource of suspended\) broker\.resourceOwners\.delete\(resource\)/
  );
  assert.match(
    background,
    /suspendOwnedResources\(\[[\s\S]*"emulation"[\s\S]*"events"[\s\S]*restoredBroker\.resourceOwners = priorBrokerState\.resourceOwners/
  );
  assert.match(
    background,
    /decidePendingApproval[\s\S]*record\.workerInstanceId !== WORKER_INSTANCE_ID/
  );
  assert.match(background, /resourceOwners: new Map\(\)/);
  assert.match(background, /claimCdpResource/);
  assert.match(background, /releaseCdpResource/);
  assert.match(background, /assertExpertCdpResourceSafe/);
  assert.match(background, /CdpResourceInUse/);
  assert.match(background, /cdpDetachIfIdle/);
  assert.match(background, /cdpDetachSession/);
  assert.match(background, /sessionDetachDecision/);
  assert.doesNotMatch(background, /cdpDetachAll/);
  assert.match(background, /preservedResourceOwners/);
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
  assert.match(background, /const nativeCheckable = tag === "input"/);
  assert.match(background, /const ariaCheckable = \["checkbox", "radio", "switch"/);
  assert.match(background, /checkable,/);
  assert.match(background, /element\.indeterminate[\s\S]*\? "mixed"/);
  assert.match(background, /checkedState !== desiredState/);
  assert.match(background, /includeHidden: action === "upload"/);
  assert.match(background, /payload\.includeHidden === true \|\| visible\(element\)/);
});

test("unchecked waits match present false state, including a delayed transition", async () => {
  const helpers = await stageOneHelpers();
  const checked = { count: 1, target: { checkable: true, checkedState: "true" } };
  const unchecked = { count: 1, target: { checkable: true, checkedState: "false" } };
  assert.equal(helpers.locatorWaitMatches("checked", checked), true);
  assert.equal(helpers.locatorWaitMatches("checked", unchecked), false);
  assert.equal(helpers.locatorWaitMatches("unchecked", unchecked), true);
  assert.equal(helpers.locatorWaitMatches("unchecked", checked), false);
  const delayed = [checked, checked, unchecked]
    .findIndex((snapshot) => helpers.locatorWaitMatches("unchecked", snapshot));
  assert.equal(delayed, 2);
});

test("locator wait matching preserves detached and timeout boundaries", async () => {
  const helpers = await stageOneHelpers();
  assert.equal(helpers.locatorWaitMatches("detached", { count: 0, target: null }), true);
  assert.equal(helpers.locatorWaitMatches("unchecked", { count: 0, target: null }), false);
  assert.equal(helpers.locatorWaitMatches("unchecked", {
    count: 1,
    target: { tag: "button", type: "", role: "button", checkable: false, checkedState: "false" }
  }), false);
  assert.equal(helpers.locatorWaitMatches("unchecked", {
    count: 1,
    target: { tag: "input", type: "text", role: "textbox", checkable: false, checkedState: "false" }
  }), false);
  const mixed = { count: 1, target: { checkable: true, checkedState: "mixed" } };
  assert.equal(helpers.locatorWaitMatches("checked", mixed), false);
  assert.equal(helpers.locatorWaitMatches("unchecked", mixed), false);
  assert.equal(
    [
      { count: 1, target: { checkable: true, checkedState: "true" } },
      { count: 1, target: { checkable: true, checkedState: "mixed" } },
      { count: 1, target: { checkable: false, checkedState: "false" } }
    ]
      .some((snapshot) => helpers.locatorWaitMatches("unchecked", snapshot)),
    false
  );
});

test("download ownership is isolated by session and legacy records fail closed", async () => {
  const helpers = await stageOneHelpers();
  const records = [
    { downloadId: 10, sessionId: "session-a" },
    { downloadId: 20, sessionId: "session-b" },
    30
  ];
  assert.deepEqual([...helpers.downloadIdsForSession(records, "session-a")], [10]);
  assert.deepEqual([...helpers.downloadIdsForSession(records, "session-b")], [20]);
  assert.deepEqual([...helpers.downloadIdsForSession(records, "session-c")], []);
  const reserved = helpers.reserveDownload(records, "reservation-a", "session-a");
  const claimed = helpers.fulfillDownloadReservation(
    reserved, "reservation-a", 40, "session-a");
  assert.deepEqual([...helpers.downloadIdsForSession(claimed, "session-a")], [10, 40]);
  assert.throws(
    () => helpers.fulfillDownloadReservation(
      reserved, "reservation-a", 20, "session-a"),
    (error) => error?.name === "OwnershipError"
  );
  assert.throws(
    () => helpers.fulfillDownloadReservation(
      reserved, "reservation-a", 30, "session-a"),
    (error) => error?.name === "OwnershipError"
  );
  const afterForeignDelete = helpers.forgetDownloadForSession(records, 20, "session-a");
  assert.equal(afterForeignDelete.some((entry) =>
    entry.downloadId === 20 && entry.sessionId === "session-b"), true);
});

test("download ownership capacity reserves before side effects and closed sessions release their records", async () => {
  const helpers = await stageOneHelpers();
  const oldSessionFull = Array.from({ length: 200 }, (_, index) => ({
    downloadId: index,
    sessionId: "closed-session"
  }));
  let sideEffects = 0;
  assert.throws(
    () => {
      const reserved = helpers.reserveDownload(
        oldSessionFull, "new-reservation", "new-session");
      sideEffects += 1;
      return reserved;
    },
    (error) => error?.name === "OwnershipError"
  );
  assert.equal(sideEffects, 0);

  const released = helpers.releaseSessionDownloads(oldSessionFull, "closed-session");
  const reserved = helpers.reserveDownload(released, "new-reservation", "new-session");
  sideEffects += 1;
  const claimed = helpers.fulfillDownloadReservation(
    reserved, "new-reservation", 1000, "new-session");
  assert.equal(sideEffects, 1);
  assert.deepEqual([...helpers.downloadIdsForSession(claimed, "new-session")], [1000]);
});

test("download reservation rollback and release affect only the owning session", async () => {
  const helpers = await stageOneHelpers();
  const records = [
    { downloadId: 10, sessionId: "session-a" },
    { downloadId: 20, sessionId: "session-b" }
  ];
  const reserved = helpers.reserveDownload(records, "reservation-a", "session-a");
  const rolledBack = helpers.rollbackDownloadReservation(
    reserved, "reservation-a", "session-a");
  assert.deepEqual(
    JSON.parse(JSON.stringify(rolledBack)),
    JSON.parse(JSON.stringify(records))
  );
  const released = helpers.releaseSessionDownloads(reserved, "session-a");
  assert.deepEqual([...helpers.downloadIdsForSession(released, "session-a")], []);
  assert.deepEqual([...helpers.downloadIdsForSession(released, "session-b")], [20]);
  assert.equal(
    helpers.ownedDownloadRecords(released)
      .some((entry) => entry.reservationId === "reservation-a"),
    false
  );
});

test("Stage Two StateStore serializes four logical session mutations", async () => {
  const helpers = await stageTwoHelpers();
  let state = {
    ownership: {},
    downloads: {},
    cdp: {}
  };
  const store = helpers.createStateStore({
    get: async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      return structuredClone(state);
    },
    set: async (next) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      state = structuredClone(next);
    }
  });
  await Promise.all(Array.from({ length: 4 }, (_, index) =>
    store.mutate({ ownership: {}, downloads: {}, cdp: {} }, (current) => {
      const sessionId = `session-${index}`;
      current.ownership[index] = sessionId;
      current.downloads[index] = sessionId;
      current.cdp[index] = sessionId;
      return current;
    })
  ));
  assert.deepEqual(Object.values(state.ownership).sort(), [
    "session-0", "session-1", "session-2", "session-3"
  ]);
  assert.deepEqual(state.downloads, state.ownership);
  assert.deepEqual(state.cdp, state.ownership);
});

test("Stage Two operation context preserves immutable identity and deadline", async () => {
  const helpers = await stageTwoHelpers();
  const context = helpers.operationContext({
    operationId: "70000000-0000-4000-8000-000000000001",
    fingerprint: "a".repeat(64),
    deadlineAt: 123456,
    payload: {
      sessionId: "session-a",
      sessionName: "A",
      sessionMode: "managed"
    }
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.session), true);
  assert.equal(context.operationId, "70000000-0000-4000-8000-000000000001");
  assert.equal(context.deadlineAt, 123456);
  assert.equal(context.session.id, "session-a");
});

test("managed nested ownership uses immutable operation context without legacy session fields", async () => {
  const helpers = await stageTwoHelpers();
  const context = helpers.operationContext({
    operationId: "71000000-0000-4000-8000-000000000001",
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() + 10_000,
    payload: {
      sessionId: "managed-a",
      sessionName: "Managed A",
      sessionMode: "managed"
    }
  });
  const nestedPayload = { tabId: 42 };
  assert.equal("sessionId" in nestedPayload, false);
  const owned = { tabId: 42, sessionId: "managed-a", kind: "created" };
  for (const command of [
    "navigate", "getText", "locatorAction", "downloadClick", "closeTab", "releaseTab"
  ]) {
    assert.equal(
      helpers.assertOwnedRecord(
        owned,
        context,
        { createdOnly: command === "closeTab" }
      ),
      owned,
      command
    );
  }
  assert.throws(
    () => helpers.assertOwnedRecord(
      owned,
      { ...context, session: { ...context.session, id: "managed-b" } }
    ),
    (error) => error?.name === "OwnershipError"
  );
});

test("all ownership helper callers pass explicit scoped context", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  const ownershipCallLines = background.split(/\r?\n/)
    .filter((line) =>
      line.includes("assertTabOwnership(")
      && !line.includes("async function assertTabOwnership"));
  assert.equal(ownershipCallLines.length > 0, true);
  assert.equal(
    ownershipCallLines.every((line) => line.includes("context")),
    true,
    ownershipCallLines.join("\n")
  );
  assert.doesNotMatch(background, /withWorkingTab\(payload\.tabId,\s*["'`]/);
  assert.doesNotMatch(background, /finishTabWork\(payload\.tabId\)(?!\s*,)/);
  assert.doesNotMatch(background, /async function setOwnership/);
  assert.doesNotMatch(background, /rememberTab\([^,\n]+,\s*[^,\n]+\)/);
  assert.match(background, /commandNavigate\(payload\)[\s\S]*withWorkingTab\(payload\.tabId, payload/);
  assert.match(background, /commandGetText\(payload\)[\s\S]*withWorkingTab\(payload\.tabId, payload/);
  assert.match(background, /commandLocatorAction\(payload\)[\s\S]*runOwnedTabOperation\(payload\.tabId, payload/);
  assert.match(background, /commandDownloadClick\(payload\)[\s\S]*withWorkingTab\(payload\.tabId, payload/);
  assert.match(background, /commandCloseTab[\s\S]*context: payload, createdOnly: true/);
  assert.match(background, /commandReleaseTab[\s\S]*context: payload/);
  assert.match(background, /commandDownloadClick[\s\S]*commandClick\(scopedPayload\(payload/);
});

test("serialized ownership mutations preserve interleaved open, child, remember, and forget", async () => {
  const helpers = await stageTwoHelpers();
  let state = { tabOwnership: {} };
  const store = helpers.createStateStore({
    get: async () => structuredClone(state),
    set: async (next) => {
      state = structuredClone(next);
    }
  });
  let resumeOpen;
  const browserWork = new Promise((resolveWork) => {
    resumeOpen = resolveWork;
  });
  const openTab = (async () => {
    await store.read({ tabOwnership: {} });
    await browserWork;
    await store.mutate({ tabOwnership: {} }, (current) => {
      current.tabOwnership[1] = {
        tabId: 1,
        sessionId: "managed-a",
        kind: "created",
        groupId: 9
      };
      return current;
    });
  })();
  await store.mutate({ tabOwnership: {} }, (current) => {
    current.tabOwnership[2] = {
      tabId: 2,
      sessionId: "managed-a",
      kind: "created-child"
    };
    return current;
  });
  resumeOpen();
  await openTab;
  await Promise.all([
    store.mutate({ tabOwnership: {} }, (current) => {
      current.tabOwnership[3] = {
        tabId: 3,
        sessionId: "managed-a",
        kind: "created"
      };
      return current;
    }),
    store.mutate({ tabOwnership: {} }, (current) => {
      delete current.tabOwnership[1];
      return current;
    })
  ]);
  assert.deepEqual(Object.keys(state.tabOwnership).sort(), ["2", "3"]);
  assert.equal(state.tabOwnership[2].kind, "created-child");
  assert.equal(state.tabOwnership[3].sessionId, "managed-a");
});

test("Stage Two byte budgets expose truncation instead of false completeness", async () => {
  const helpers = await stageTwoHelpers();
  let state = { entries: [], truncated: false, droppedCount: 0 };
  for (const value of ["a".repeat(700), "b".repeat(700), "c".repeat(700)]) {
    const next = helpers.boundedAppend(state.entries, { value }, {
      maxCount: 10,
      maxBytes: 1600
    });
    state = {
      entries: next.entries,
      truncated: state.truncated || next.truncated,
      droppedCount: state.droppedCount + next.droppedCount
    };
  }
  assert.equal(state.entries.length, 2);
  assert.equal(state.truncated, true);
  assert.equal(state.droppedCount, 1);
});

test("Stage Two frame identity rejects collisions and stale documents", async () => {
  const helpers = await stageTwoHelpers();
  const parent = { frameId: 0, documentId: "parent", result: { selector: "#same" } };
  const child = { frameId: 7, documentId: "child", result: { selector: "#same" } };
  assert.throws(() => helpers.frameTarget(parent, 7, "child"), /identity changed/);
  assert.equal(helpers.frameTarget(child, 7, "child").documentId, "child");
  assert.throws(
    () => helpers.frameTarget({ ...child, documentId: "replaced" }, 7, "child"),
    (error) => error?.name === "StaleLocatorError"
  );
});

test("Stage Two frame coordinates stay in CSS pixels across zoom and DPR", async () => {
  const helpers = await stageTwoHelpers();
  const rect = helpers.topViewportRect(
    { x: 10, y: 20, width: 100, height: 40 },
    [{ x: 30, y: 40 }, { x: 5, y: 6 }],
    { deviceScaleFactor: 2.5, pageScaleFactor: 1.25 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(rect)),
    {
      x: 45,
      y: 66,
      width: 100,
      height: 40,
      deviceScaleFactor: 2.5,
      pageScaleFactor: 1.25
    }
  );
  assert.throws(
    () => helpers.topViewportRect(
      { x: 0, y: 0, width: 10, height: 10 },
      [{ x: Number.NaN, y: 0 }],
      { deviceScaleFactor: 2, pageScaleFactor: 1 }
    ),
    /incomplete/
  );
});

test("orphan reconciliation preserves all tabs and releases only temporary leases", async () => {
  const helpers = await stageTwoHelpers();
  const plan = helpers.orphanReconciliationPlan([
    { type: "tab", id: 1, kind: "created", leaseExpiresAt: 1 },
    { type: "tab", id: 2, kind: "adopted", leaseExpiresAt: 1 },
    { type: "tab", id: 3, kind: "deliverable", leaseExpiresAt: 1 },
    { type: "debugger", id: 1, leaseExpiresAt: 1 },
    { type: "clean_qa_lease", id: "qa", leaseExpiresAt: 1 }
  ], 2);
  assert.deepEqual([...plan.preservedTabs], [1, 2, 3]);
  assert.deepEqual(
    [...plan.releasable].map((item) => item.type).sort(),
    ["clean_qa_lease", "debugger"]
  );
});

test("failed tab removal preserves ownership and reports cleanup_partial", async () => {
  const helpers = await stageTwoHelpers();
  const ownership = { 42: { tabId: 42, sessionId: "session-a" } };
  const removed = helpers.tabRemovalConfirmed(
    { ok: false, error: { name: "Error" } },
    { id: 42 }
  );
  const cleanup = removed
    ? { ok: true, outcome: "completed" }
    : {
      ok: false,
      outcome: "cleanup_partial",
      failures: [{ resource: "tab", tabId: 42 }]
    };
  if (removed) delete ownership[42];
  assert.equal(cleanup.outcome, "cleanup_partial");
  assert.equal(ownership[42].sessionId, "session-a");
});

test("tab removal requires explicit missing-tab evidence", async () => {
  const helpers = await stageTwoHelpers();
  const failedClose = { ok: false, error: { name: "TimeoutError" } };
  assert.equal(helpers.tabRemovalConfirmed(
    failedClose,
    { ok: false, error: { name: "TimeoutError" } }
  ), false);
  assert.equal(helpers.tabRemovalConfirmed(
    failedClose,
    { ok: false, error: { name: "NoSuchTabError" } }
  ), true);
});

test("expired orphan reservations recover capacity without removing active reservations", async () => {
  const helpers = await stageTwoHelpers();
  const now = 1_000_000;
  const ttl = 10_000;
  const entries = [
    { id: "stale-a", operationId: "a", status: "reserved", createdAt: now - ttl },
    { id: "stale-b", operationId: "b", status: "reserved", createdAt: now - ttl - 1 },
    { id: "active", operationId: "c", status: "reserved", createdAt: now - ttl - 1 },
    { id: "fresh", operationId: "d", status: "reserved", createdAt: now - 1 },
    { id: "done", operationId: "e", status: "completed", createdAt: now - ttl - 1 }
  ];
  assert.deepEqual(
    [...helpers.expiredReservationIds(entries, ["c"], now, ttl)],
    ["stale-a", "stale-b"]
  );
});

test("multi-megabyte result commands reserve enough outbox capacity", async () => {
  const helpers = await stageTwoHelpers();
  assert.equal(helpers.outboxReservationBytes("eventsPoll"), 8 * 1024 * 1024);
  assert.equal(helpers.outboxReservationBytes("networkBody"), 8 * 1024 * 1024);
  assert.equal(helpers.outboxReservationBytes("networkHar"), 8 * 1024 * 1024);
  assert.equal(helpers.outboxReservationBytes("screenshot"), 16 * 1024 * 1024);
});

test("network body result stays within its durable reservation at boundary", async () => {
  const helpers = await stageTwoHelpers();
  const resultLimit = 7 * 1024 * 1024;
  const reservation = helpers.outboxReservationBytes("networkBody");
  const complete = helpers.boundedNetworkBody(
    "request-small",
    "a".repeat(6 * 1024 * 1024),
    false,
    resultLimit
  );
  assert.equal(complete.truncated, false);
  assert.equal(complete.partial, false);
  assert.equal(complete.complete, true);

  const bounded = helpers.boundedNetworkBody(
    "request-boundary",
    "b".repeat(8 * 1024 * 1024),
    false,
    resultLimit
  );
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.outputTruncated, true);
  assert.equal(bounded.partial, true);
  assert.equal(bounded.complete, false);
  assert.equal(helpers.byteLength(bounded) <= resultLimit, true);
  assert.equal(helpers.byteLength({
    kind: "result",
    operationId: "operation",
    fingerprint: "f".repeat(64),
    payload: bounded
  }) < reservation, true);
});

test("deadline abort after dispatch is classified as effect unknown", async () => {
  const helpers = await stageTwoHelpers();
  assert.equal(helpers.abortIsEffectUnknown(true, "TimeoutError"), true);
  assert.equal(helpers.abortIsEffectUnknown(true, "AbortError"), true);
  assert.equal(helpers.abortIsEffectUnknown(true, "NotStarted"), false);
  assert.equal(helpers.abortIsEffectUnknown(false, "TimeoutError"), false);
});

test("late completion targets the current authenticated transport socket", async () => {
  const helpers = await stageTwoHelpers();
  const original = { readyState: 1, id: "original" };
  const current = { readyState: 1, id: "current" };
  assert.equal(
    helpers.resultTransportSocket(current, "connected", 1),
    current
  );
  original.readyState = 3;
  assert.equal(
    helpers.resultTransportSocket(original, "connected", 1),
    null
  );
});

test("nested-frame double click emits two clicks and one dblclick", async () => {
  const helpers = await stageTwoHelpers();
  assert.deepEqual(
    [...helpers.clickEventPlan(true)],
    ["click", "click", "dblclick"]
  );
  assert.deepEqual([...helpers.clickEventPlan(false)], ["click"]);
});

test("retained truncated frame makes the aggregate partial", async () => {
  const helpers = await stageTwoHelpers();
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.aggregateCompleteness([
      { frameId: 0, result: { truncated: false, complete: true } },
      { frameId: 7, result: { truncated: true, complete: false } }
    ], false))),
    { truncated: true, partial: true, complete: false }
  );
});

test("allFrames observe structured and nested truncation makes aggregate partial", async () => {
  const helpers = await stageTwoHelpers();
  const allFramesObserveFixture = [
    {
      frameId: 0,
      result: {
        truncated: { interactive: true },
        outputTruncated: false
      }
    },
    {
      frameId: 7,
      result: {
        outputTruncated: true
      }
    },
    {
      frameId: 8,
      result: {
        outputTruncated: false,
        metadata: { complete: false }
      }
    }
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      helpers.aggregateCompleteness(allFramesObserveFixture, false)
    )),
    { truncated: true, partial: true, complete: false }
  );
});

test("bounded event, trace, and screencast results expose additive partial metadata", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  assert.match(background, /commandEventsPoll[\s\S]*partial: broker\.eventsTruncated/);
  assert.match(background, /commandTraceStop[\s\S]*partial: truncated/);
  assert.match(background, /commandScreencastFrame[\s\S]*partial: broker\.screencastTruncated/);
  assert.match(background, /boundedFrameAggregate[\s\S]*partial: completeness\.partial/);
});

test("download click and image paths reserve before browser side effects", async () => {
  const background = await readFile(
    resolve(root, "apps", "extension", "background.js"),
    "utf8"
  );
  assert.match(background, /async function commandDownloadClick[\s\S]*reserveDownloadOwnership\(session\.id\)[\s\S]*commandClick/);
  assert.match(background, /signal\?\.item[\s\S]*fulfillDownloadOwnership\(reservationId, signal\.item\.id, session\.id\)/);
  assert.match(background, /async function commandDownloadImage[\s\S]*reserveDownloadOwnership\(session\.id\)[\s\S]*chrome\.downloads\.download/);
  assert.match(background, /chrome\.downloads\.download[\s\S]*catch \(error\)[\s\S]*rollbackDownloadOwnership\(reservationId, session\.id\)/);
  assert.match(background, /action\.actionAccepted !== true[\s\S]*rollbackDownloadOwnership\(reservationId, session\.id\)/);
  assert.match(background, /throw downloadOutcomeUnknown\(\s*"post_click_timeout"/);
  assert.match(background, /phase,[\s\S]*reservationHeld: true,[\s\S]*retrySafe: false/);
  assert.doesNotMatch(background, /kind: "timeout"[\s\S]*ownershipReservationHeld/);
  assert.match(background, /commandReleaseWorkspace[\s\S]*releaseSessionDownloads\(session\.id\)/);
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
  const installer = await readFile(
    resolve(root, "scripts", "install-mcp.mjs"),
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
  assert.match(installer, /delete npmEnvironment\.npm_config_prefix/);
  assert.match(installer, /installedManifest\.version !== packageJson\.version/);
  assert.equal(marketplace.plugins[0].name, "tabward");
});
