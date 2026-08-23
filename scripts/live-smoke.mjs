import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const serverPath = resolve(root, "packages", "mcp", "dist", "index.js");
const useGlobalCommand = process.env.TABWARD_SMOKE_GLOBAL_COMMAND === "1";
const globalServerPath = resolve(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "@tabward",
  "mcp",
  "dist",
  "index.js"
);
const sessionMode = process.env.TABWARD_SMOKE_MODE === "full_profile"
  ? "full_profile"
  : "managed";
const expectedWorkspace = process.env.TABWARD_EXPECT_WORKSPACE || null;
const expectedExistingAccess =
  process.env.TABWARD_EXPECT_EXISTING_ACCESS
  || (sessionMode === "managed" ? "denied" : null);
const client = new Client({ name: "tabward-live-smoke", version: "0.2.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: useGlobalCommand
    ? [globalServerPath]
    : [serverPath],
  stderr: "pipe"
});

function structured(result) {
  if (!result || typeof result.structuredContent !== "object") {
    const detail = Array.isArray(result?.content)
      ? result.content
        .filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join("\n")
      : "";
    throw new Error(
      `MCP tool returned no structured content${detail ? `: ${detail}` : ""}`
    );
  }
  return result.structuredContent;
}

async function call(name, args = {}) {
  return structured(await client.callTool({ name, arguments: args }));
}

async function waitForConnection() {
  const deadline = Date.now() + 180_000;
  let printedCode = null;
  while (Date.now() < deadline) {
    const health = await call("tabward_health");
    if (health.ok === true) {
      console.log(JSON.stringify({
        event: "paired",
        extensionVersion: health.bridge.extensionVersion
      }));
      return;
    }
    if (
      health.bridge?.state === "pairing_required"
      && typeof health.bridge.pairingCode === "string"
      && health.bridge.pairingCode !== printedCode
    ) {
      printedCode = health.bridge.pairingCode;
      console.log(JSON.stringify({
        event: "pairing_required",
        code: printedCode
      }));
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Timed out waiting for TabWard pairing");
}

await client.connect(transport);
let sessionId = null;
try {
  await waitForConnection();
  const started = await call("tabward_session_start", {
    mode: sessionMode,
    name: "TabWard live smoke",
    ttl_seconds: 300
  });
  sessionId = started.session.sessionId;
  if (
    expectedWorkspace
    && started.session.workspace !== expectedWorkspace
  ) {
    throw new Error(
      `Expected workspace ${expectedWorkspace}, received ${started.session.workspace}`
    );
  }
  console.log(JSON.stringify({
    event: "session_started",
    sessionId,
    workspace: started.session.workspace
  }));

  const opened = await call("tabward_tabs", {
    session_id: sessionId,
    operation: "open",
    url: "https://example.com/",
    active: false,
    wait: true
  });
  const tabId = opened.tab?.id;
  if (!Number.isInteger(tabId)) {
    throw new Error("TabWard did not return a created tab ID");
  }
  console.log(JSON.stringify({ event: "tab_opened", tabId }));

  const listed = await call("tabward_tabs", {
    session_id: sessionId,
    operation: "list"
  });
  if (
    expectedExistingAccess
    && listed.existingTabAccess !== expectedExistingAccess
  ) {
    throw new Error(
      `Expected existing-tab access ${expectedExistingAccess}, received ${listed.existingTabAccess}`
    );
  }
  console.log(JSON.stringify({
    event: "policy_verified",
    mode: sessionMode,
    workspace: started.session.workspace,
    existingTabAccess: listed.existingTabAccess,
    availableTabCount: Array.isArray(listed.availableTabs)
      ? listed.availableTabs.length
      : 0
  }));
  if (
    !Array.isArray(listed.knownTabs)
    || !listed.knownTabs.some((tab) => tab.id === tabId)
  ) {
    throw new Error("Managed tab was not present in the session-owned list");
  }
  console.log(JSON.stringify({
    event: "session_list_verified",
    sessionTabCount: listed.knownTabs.length
  }));

  const observed = await call("tabward_observe", {
    session_id: sessionId,
    tab_id: tabId,
    mode: "state",
    max_chars: 10_000
  });
  const title = observed.title
    ?? observed.state?.title
    ?? observed.page?.title
    ?? "";
  if (!String(title).includes("Example Domain")) {
    throw new Error(`Unexpected observed title: ${String(title)}`);
  }

  console.log(JSON.stringify({
    event: "smoke_passed",
    sessionId,
    tabId,
    title: String(title),
    managedTabCount: listed.knownTabs.length
  }));
} finally {
  if (sessionId) {
    try {
      await call("tabward_session_close", {
        session_id: sessionId,
        close_created_tabs: true
      });
    } catch (error) {
      console.error(`cleanup failed: ${error.message}`);
    }
  }
  await client.close();
}
