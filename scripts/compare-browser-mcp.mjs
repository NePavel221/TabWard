import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cycles = Number(process.env.TABWARD_COMPARE_CYCLES || 10);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) {
  throw new Error("TABWARD_COMPARE_CYCLES must be an integer from 1 to 100");
}

const fixture = createServer((_request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(`<!doctype html><html><head><title>Browser MCP fixture</title></head>
<body><main><label>Value <input aria-label="Value"></label>
<button type="button">Apply</button><output>idle</output>
<script>
document.querySelector("button").onclick = () => {
  document.querySelector("output").textContent = document.querySelector("input").value;
};
</script></main></body></html>`);
});
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

const adapters = {
  tabward: {
    command: process.execPath,
    args: [join(
      process.env.APPDATA || "",
      "npm", "node_modules", "@tabward", "mcp", "dist", "index.js"
    )],
    prefix: "tabward",
    start: {
      mode: "managed",
      name: "Comparative benchmark",
      ttl_seconds: 1800
    }
  },
  droider: {
    command: join(
      process.env.LOCALAPPDATA || "",
      "DroidER", ".venv", "Scripts", "python.exe"
    ),
    args: [join(
      process.env.LOCALAPPDATA || "",
      "DroidER", "bridge", "mcp_server.py"
    )],
    prefix: "droider",
    start: {
      mode: "managed",
      workspace: "isolated",
      name: "Comparative benchmark",
      ttl_seconds: 1800
    }
  }
};

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0);
}

async function connect(name, adapter) {
  const transport = new StdioClientTransport({
    command: adapter.command,
    args: adapter.args,
    stderr: "pipe"
  });
  const client = new Client({ name: `${name}-comparison`, version: "0.2.0" });
  await client.connect(transport);
  const call = async (suffix, args = {}) => {
    const result = await client.callTool({
      name: `${adapter.prefix}_${suffix}`,
      arguments: args
    });
    if (!result?.structuredContent) {
      const text = result?.content?.find((item) => item.type === "text")?.text || "";
      throw new Error(text || `${name} returned no structured content`);
    }
    return result.structuredContent;
  };
  const health = await call("health");
  const started = await call("session_start", adapter.start);
  return {
    client,
    call,
    sessionId: started.session.sessionId,
    version: health.serverVersion
  };
}

const states = {};
const metrics = {
  tabward: { durations: [], failures: [] },
  droider: { durations: [], failures: [] }
};

async function oneCycle(name, index) {
  const state = states[name];
  const startedAt = performance.now();
  let tabId = null;
  try {
    const opened = await state.call("tabs", {
      session_id: state.sessionId,
      operation: "open",
      url: fixtureUrl,
      active: false,
      wait: true
    });
    tabId = opened.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error("open returned no tab id");
    const observed = await state.call("observe", {
      session_id: state.sessionId,
      tab_id: tabId,
      mode: "state",
      max_chars: 10_000
    });
    if (!String(observed.title || "").includes("Browser MCP fixture")) {
      throw new Error("unexpected fixture title");
    }
    const value = `${name}-${index}`;
    await state.call("action", {
      session_id: state.sessionId,
      tab_id: tabId,
      action: "fill",
      locator: { label: "Value" },
      value
    });
    await state.call("action", {
      session_id: state.sessionId,
      tab_id: tabId,
      action: "click",
      locator: { role: "button", name: "Apply" }
    });
    await state.call("assert", {
      session_id: state.sessionId,
      tab_id: tabId,
      assertion: "text",
      locator: { selector: "output" },
      expected: value
    });
  } catch (error) {
    metrics[name].failures.push({
      cycle: index + 1,
      name: error?.name || "Error",
      message: String(error?.message || error).slice(0, 300)
    });
  } finally {
    if (tabId !== null) {
      await state.call("tabs", {
        session_id: state.sessionId,
        operation: "close",
        tab_id: tabId
      }).catch((error) => metrics[name].failures.push({
        cycle: index + 1,
        name: "CleanupError",
        message: String(error?.message || error).slice(0, 300)
      }));
    }
    metrics[name].durations.push(performance.now() - startedAt);
  }
}

try {
  states.tabward = await connect("tabward", adapters.tabward);
  states.droider = await connect("droider", adapters.droider);
  for (let index = 0; index < cycles; index += 1) {
    const order = index % 2 === 0
      ? ["tabward", "droider"]
      : ["droider", "tabward"];
    for (const name of order) await oneCycle(name, index);
  }
  const results = Object.fromEntries(Object.entries(metrics).map(([name, value]) => [
    name,
    (() => {
      const failedCycles = new Set(value.failures.map((failure) => failure.cycle)).size;
      return {
      version: states[name].version,
      cycles,
      passed: cycles - failedCycles,
      failed: failedCycles,
      p50Ms: percentile(value.durations, 0.5),
      p95Ms: percentile(value.durations, 0.95),
      failures: value.failures
      };
    })()
  ]));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: "local",
    results,
    tabwardNotWorse: results.tabward.failed <= results.droider.failed
      && results.tabward.p50Ms <= results.droider.p50Ms * 1.1
      && results.tabward.p95Ms <= results.droider.p95Ms * 1.1
  };
  const reportDir = resolve(root, ".factory", "temp");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, "browser-mcp-comparison.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.tabwardNotWorse) process.exitCode = 1;
} finally {
  for (const state of Object.values(states)) {
    await state.call("session_close", {
      session_id: state.sessionId,
      close_created_tabs: true
    }).catch(() => {});
    await state.client.close().catch(() => {});
  }
  await new Promise((resolveClose) => fixture.close(resolveClose));
}
