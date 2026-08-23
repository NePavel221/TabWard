import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cycles = Number(process.env.TABWARD_GATE_CYCLES || 50);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 500) {
  throw new Error("TABWARD_GATE_CYCLES must be an integer from 1 to 500");
}

const fixture = createServer((_request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(`<!doctype html>
<html><head><title>TabWard replacement fixture</title></head>
<body><main>
  <h1>Replacement fixture</h1>
  <label>Value <input aria-label="Value" value=""></label>
  <button type="button" id="apply">Apply</button>
  <output id="result">idle</output>
  <script>
    document.querySelector("#apply").addEventListener("click", () => {
      document.querySelector("#result").textContent =
        document.querySelector("input").value;
    });
  </script>
</main></body></html>`);
});
await new Promise((resolveListen) =>
  fixture.listen(0, "127.0.0.1", resolveListen)
);
const fixturePort = fixture.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

const globalServerPath = join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "@tabward",
  "mcp",
  "dist",
  "index.js"
);
const localServerPath = resolve(root, "packages", "mcp", "dist", "index.js");
const serverPath = process.env.TABWARD_GATE_GLOBAL === "1"
  ? globalServerPath
  : localServerPath;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe"
});
const client = new Client({ name: "tabward-replacement-gate", version: "0.3.0" });
const durations = [];
const failures = [];
let sessionId = null;

function structured(result) {
  if (!result?.structuredContent) {
    throw new Error("MCP result has no structuredContent");
  }
  return result.structuredContent;
}

async function call(name, args = {}) {
  return structured(await client.callTool({ name, arguments: args }));
}

async function waitForReady() {
  const deadline = Date.now() + 45_000;
  let health = null;
  while (Date.now() < deadline) {
    health = await call("tabward_health");
    if (health.ok === true) return health;
    if (health.bridge?.state === "pairing_required") {
      throw new Error("TabWard pairing is required; approve the code in the extension popup");
    }
    if (health.bridge?.state === "version_mismatch") {
      throw new Error("TabWard MCP and extension protocol versions do not match");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`TabWard did not become ready: ${JSON.stringify(health?.bridge)}`);
}

try {
  await client.connect(transport);
  const health = await waitForReady();
  const started = await call("tabward_session_start", {
    mode: "managed",
    name: "Replacement gate",
    ttl_seconds: 1800
  });
  sessionId = started.session.sessionId;

  for (let index = 0; index < cycles; index += 1) {
    const startedAt = performance.now();
    let tabId = null;
    try {
      const opened = await call("tabward_tabs", {
        session_id: sessionId,
        operation: "open",
        url: fixtureUrl,
        active: false,
        wait: true
      });
      tabId = opened.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error("open returned no tab id");
      const state = await call("tabward_observe", {
        session_id: sessionId,
        tab_id: tabId,
        mode: "state",
        max_chars: 10_000
      });
      if (!String(state.title || "").includes("TabWard replacement fixture")) {
        throw new Error(`unexpected title: ${String(state.title || "")}`);
      }
      await call("tabward_action", {
        session_id: sessionId,
        tab_id: tabId,
        action: "fill",
        locator: { label: "Value" },
        value: `cycle-${index}`
      });
      await call("tabward_action", {
        session_id: sessionId,
        tab_id: tabId,
        action: "click",
        locator: { role: "button", name: "Apply" }
      });
      await call("tabward_assert", {
        session_id: sessionId,
        tab_id: tabId,
        assertion: "text",
        locator: { selector: "#result" },
        expected: `cycle-${index}`
      });
    } catch (error) {
      failures.push({
        cycle: index + 1,
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 500)
      });
    } finally {
      if (tabId !== null) {
        await call("tabward_tabs", {
          session_id: sessionId,
          operation: "close",
          tab_id: tabId
        }).catch((error) => failures.push({
          cycle: index + 1,
          name: "CleanupError",
          message: String(error?.message || error).slice(0, 500)
        }));
      }
      durations.push(performance.now() - startedAt);
    }
  }

  const listed = await call("tabward_tabs", {
    session_id: sessionId,
    operation: "list"
  });
  const leakedTabs = Array.isArray(listed.knownTabs)
    ? listed.knownTabs.filter((tab) => tab.sessionId === sessionId)
    : [];
  const sorted = [...durations].sort((a, b) => a - b);
  const failedCycles = new Set(failures.map((failure) => failure.cycle)).size;
  const percentile = (ratio) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: "TabWard",
    version: health.serverVersion,
    cycles,
    passed: cycles - failedCycles,
    failed: failedCycles,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    leakedTabs: leakedTabs.map((tab) => tab.id),
    failures,
    gatePassed: failures.length === 0 && leakedTabs.length === 0
  };
  const reportDir = resolve(root, ".factory", "temp");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, "replacement-gate.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.gatePassed) process.exitCode = 1;
} finally {
  if (sessionId) {
    await call("tabward_session_close", {
      session_id: sessionId,
      close_created_tabs: true
    }).catch(() => {});
  }
  await client.close().catch(() => {});
  await new Promise((resolveClose) => fixture.close(resolveClose));
}
