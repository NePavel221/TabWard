import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reportDir = resolve(root, ".factory", "temp");
const uploadPath = resolve(reportDir, "frontend-qa-upload.txt");
const reportPath = resolve(reportDir, "frontend-qa-gate.json");
const serverPath = process.env.TABWARD_QA_GLOBAL === "1"
  ? join(
    process.env.APPDATA || "",
    "npm", "node_modules", "@tabward", "mcp", "dist", "index.js"
  )
  : resolve(root, "packages", "mcp", "dist", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe"
});
const client = new Client({ name: "tabward-frontend-qa-gate", version: "0.3.0" });
const fixture = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/data") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    });
    response.end(JSON.stringify({ ok: true, source: "frontend-qa-gate" }));
    return;
  }
  if (url.pathname === "/download") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": "attachment; filename=tabward-qa-download.txt",
      "Content-Type": "text/plain"
    });
    response.end("TabWard frontend QA download fixture\n");
    return;
  }
  if (url.pathname === "/frame") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end("<!doctype html><title>QA frame</title><button id=\"frame-button\">Frame action</button>");
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(`<!doctype html>
<html><head><title>TabWard frontend QA fixture</title>
<style>
body{font:16px system-ui;margin:24px;min-height:1600px}main{max-width:720px}
label{display:block;margin:12px 0}.card{padding:16px;border:2px solid #246;border-radius:8px}
#drag-source,#drop-target{display:inline-grid;place-items:center;width:140px;height:70px;margin:12px}
#drag-source{background:#bde}#drop-target{border:2px dashed #468}
</style></head>
<body><main>
  <h1>Frontend QA fixture</h1>
  <section class="card" id="form-card">
    <label>Name <input aria-label="Name"></label>
    <label><input type="checkbox" aria-label="Accept terms"> Accept terms</label>
    <label>Plan <select aria-label="Plan"><option>Basic</option><option>Pro</option></select></label>
    <button id="submit" type="button">Apply form</button>
    <output id="form-result">idle</output>
  </section>
  <button id="fetch" type="button">Fetch data</button><output id="fetch-result">idle</output>
  <button id="history" type="button">Push route</button>
  <button id="dialog" type="button">Open dialog</button>
  <label for="upload">Upload</label><input id="upload" type="file" hidden><output id="upload-result">idle</output>
  <a id="download" href="/download" download>Download fixture</a>
  <div id="drag-source" draggable="true">Drag source</div>
  <div id="drop-target">Drop target</div><output id="drag-result">idle</output>
  <div id="shadow-host"></div>
  <iframe title="QA frame" src="/frame"></iframe>
  <script>
    const byId = (id) => document.getElementById(id);
    byId("submit").onclick = () => {
      byId("form-result").textContent =
        [document.querySelector("[aria-label='Name']").value,
         document.querySelector("[aria-label='Accept terms']").checked,
         document.querySelector("[aria-label='Plan']").value].join("|");
    };
    byId("fetch").onclick = async () => {
      console.log("qa-fetch-start");
      const data = await fetch("/api/data").then((value) => value.json());
      byId("fetch-result").textContent = data.source;
    };
    byId("history").onclick = () => history.pushState({}, "", "/route-one");
    byId("dialog").onclick = () => alert("TabWard QA dialog");
    byId("upload").onchange = () => {
      byId("upload-result").textContent = byId("upload").files[0]?.name || "none";
    };
    byId("drag-source").ondragstart = (event) => event.dataTransfer.setData("text/plain", "tabward");
    byId("drop-target").ondragover = (event) => event.preventDefault();
    byId("drop-target").ondrop = (event) => {
      event.preventDefault();
      byId("drag-result").textContent = event.dataTransfer.getData("text/plain");
    };
    const shadow = byId("shadow-host").attachShadow({ mode: "open" });
    shadow.innerHTML = "<button id='shadow-button'>Shadow action</button>";
  </script>
</main></body></html>`);
});

const checks = [];
const artifacts = [];
const durations = [];
let callCount = 0;
let sessionId = null;
let tabId = null;
let blankTabId = null;
let downloadId = null;

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0);
}

function structured(result, name) {
  if (result?.isError === true || !result?.structuredContent) {
    const text = result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    throw new Error(text || `${name} returned no structured content`);
  }
  return result.structuredContent;
}

async function call(name, args = {}) {
  const startedAt = performance.now();
  const requestedTimeout = Number(args.timeout_ms || 60_000);
  const clientTimeout = Math.max(60_000, requestedTimeout + 30_000);
  try {
    return structured(await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: clientTimeout, maxTotalTimeout: clientTimeout }
    ), name);
  } finally {
    callCount += 1;
    durations.push(performance.now() - startedAt);
  }
}

async function expectFailure(name, args, pattern) {
  try {
    await call(name, args);
  } catch (error) {
    if (pattern.test(String(error?.message || error))) return;
    throw error;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

async function closeOwnedTab(tabToClose) {
  try {
    await call("tabward_tabs", {
      session_id: sessionId,
      operation: "close",
      tab_id: tabToClose
    });
    return { closed: true, reconciled: false };
  } catch (error) {
    if (!/OutcomeUnknown/.test(String(error?.message || error))) throw error;
    const listed = await call("tabward_tabs", {
      session_id: sessionId,
      operation: "list"
    });
    if ((listed.knownTabs || []).some((tab) => tab.id === tabToClose)) {
      throw error;
    }
    return { closed: true, reconciled: true };
  }
}

async function check(name, operation) {
  const startedAt = performance.now();
  try {
    await operation();
    checks.push({ name, ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: {
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 500)
      }
    });
  }
}

async function waitForReady() {
  const deadline = Date.now() + 45_000;
  let health = null;
  while (Date.now() < deadline) {
    health = await call("tabward_health");
    if (health.ok === true) return health;
    if (health.bridge?.state === "pairing_required") {
      throw new Error("TabWard pairing is required");
    }
    if (health.bridge?.state === "version_mismatch") {
      throw new Error("TabWard extension and MCP versions do not match");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`TabWard did not become ready: ${JSON.stringify(health?.bridge)}`);
}

await mkdir(reportDir, { recursive: true });
await writeFile(uploadPath, "TabWard frontend QA upload fixture\n", "utf8");
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

try {
  await client.connect(transport);
  const health = await waitForReady();
  const started = await call("tabward_session_start", {
    mode: "managed",
    name: "Frontend QA gate",
    ttl_seconds: 900
  });
  sessionId = started.session.sessionId;
  const opened = await call("tabward_tabs", {
    session_id: sessionId,
    operation: "open",
    url: fixtureUrl,
    active: false,
    wait: true
  });
  tabId = opened.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("Fixture open returned no tab ID");

  await check("semantic form", async () => {
    const form = await call("tabward_form", {
      session_id: sessionId,
      tab_id: tabId,
      fields: [
        { locator: { label: "Name" }, action: "fill", value: "TabWard" },
        { locator: { label: "Accept terms" }, action: "check" },
        { locator: { selector: "[aria-label='Plan']" }, action: "select", value: "Pro" }
      ],
      submit_locator: { role: "button", name: "Apply form" }
    });
    if (form.ok !== true || form.submitted !== true) {
      throw new Error(`form command failed: ${JSON.stringify(form)}`);
    }
    const assertion = await call("tabward_assert", {
      session_id: sessionId,
      tab_id: tabId,
      assertion: "text",
      locator: { selector: "#form-result" },
      expected: "TabWard|true|Pro",
      soft: true
    });
    if (assertion.passed !== true) {
      throw new Error(`unexpected form result: ${JSON.stringify(assertion.actual)}`);
    }
  });

  await check("structured probes and shadow DOM", async () => {
    const metrics = await call("tabward_probe", {
      session_id: sessionId, tab_id: tabId, operation: "page_metrics"
    });
    if (metrics.ok !== true || !metrics.viewport?.width) throw new Error("page metrics missing");
    const shadow = await call("tabward_probe", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "accessibility",
      selector: "#shadow-host >>> #shadow-button"
    });
    if (shadow.role !== "button" || shadow.name !== "Shadow action") {
      throw new Error("shadow accessibility probe failed");
    }
  });

  await check("iframe observation", async () => {
    const observed = await call("tabward_observe", {
      session_id: sessionId,
      tab_id: tabId,
      mode: "text",
      all_frames: true,
      max_frames: 10,
      max_chars: 20_000
    });
    if (!Array.isArray(observed.frames)
      || !observed.frames.some((frame) => JSON.stringify(frame.result).includes("Frame action"))) {
      throw new Error("iframe content was not observed");
    }
  });

  await check("composite mobile QA and screenshots", async () => {
    await call("tabward_emulation", {
      session_id: sessionId,
      tab_id: tabId,
      settings: {
        viewport: {
          width: 777,
          height: 555,
          deviceScaleFactor: 1,
          mobile: false,
          touch: false
        }
      }
    });
    const priorEvents = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "start",
      categories: ["console"]
    });
    const qa = await call("tabward_qa", {
      session_id: sessionId,
      tab_id: tabId,
      preset: "mobile",
      probes: [
        { operation: "overflow" },
        { operation: "box", locator: { selector: "#form-card" } }
      ],
      assertions: [
        { assertion: "title", expected: { contains: "TabWard frontend QA fixture" } },
        { assertion: "visible", locator: { selector: "#form-card" } }
      ],
      screenshots: [
        { scope: "viewport", name: "frontend-qa-viewport" },
        { scope: "full_page", name: "frontend-qa-full" },
        { scope: "element", locator: { selector: "#form-card" }, name: "frontend-qa-element" }
      ],
      timeout_ms: 120_000
    });
    for (const screenshot of qa.screenshots || []) {
      if (screenshot.artifact?.path) artifacts.push(screenshot.artifact.path);
    }
    if (qa.ok !== true) throw new Error(`composite QA failed: ${JSON.stringify(qa.consoleErrors || qa.steps)}`);
    const restoredMetrics = await call("tabward_probe", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "page_metrics"
    });
    if (Math.abs(Number(restoredMetrics.viewport?.width || 0) - 777) > 2
      || Math.abs(Number(restoredMetrics.viewport?.height || 0) - 555) > 2) {
      throw new Error(
        `composite QA did not restore viewport: ${JSON.stringify({
          viewport: restoredMetrics.viewport,
          cleanup: (qa.cleanup || []).map((item) => ({
            operation: item.operation,
            ok: item.ok,
            previousStateRestored: item.result?.previousStateRestored,
            preservedExistingAttachment: item.result?.preservedExistingAttachment,
            restoredApplied: item.result?.restored?.applied
          }))
        })}`
      );
    }
    await call("tabward_evaluate", {
      session_id: sessionId,
      tab_id: tabId,
      expression: "console.log('qa-preserved-events'); true"
    });
    const restoredEvents = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "poll",
      cursor: priorEvents.cursor,
      categories: ["console"],
      limit: 500
    });
    if (!(restoredEvents.events || []).some((event) =>
      JSON.stringify(event.params || {}).includes("qa-preserved-events")
    )) {
      throw new Error("composite QA did not restore prior console capture");
    }
    await call("tabward_emulation", {
      session_id: sessionId,
      tab_id: tabId,
      settings: { clear: true }
    });
    await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "stop"
    });
    if (!Array.isArray(qa.cleanup) || qa.cleanup.some((item) => item.ok !== true)) {
      throw new Error("composite QA cleanup failed");
    }
    if ((qa.screenshots || []).length !== 3) throw new Error("scoped screenshots missing");
    const width = await call("tabward_evaluate", {
      session_id: sessionId,
      tab_id: tabId,
      expression: "window.innerWidth"
    });
    if (Number(width.result?.value) < 700) throw new Error("mobile viewport was not cleared");
  });

  await check("console, network, and response body", async () => {
    const events = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "start",
      categories: ["console", "network"]
    });
    await call("tabward_evaluate", {
      session_id: sessionId,
      tab_id: tabId,
      expression: "console.log('qa-console-probe'); true"
    });
    await call("tabward_action", {
      session_id: sessionId,
      tab_id: tabId,
      action: "click",
      locator: { selector: "#fetch" },
      options: { waitAfterMs: 500 }
    });
    await call("tabward_assert", {
      session_id: sessionId,
      tab_id: tabId,
      assertion: "text",
      locator: { selector: "#fetch-result" },
      expected: "frontend-qa-gate"
    });
    const polled = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "poll",
      cursor: events.cursor,
      categories: ["console", "network"],
      limit: 500
    });
    if (!(polled.events || []).some((event) =>
      ["Runtime.consoleAPICalled", "Log.entryAdded"].includes(event.method)
      && /qa-console-probe|qa-fetch-start/.test(JSON.stringify(event.params || {}))
    )) {
      throw new Error("console event missing");
    }
    const responseEvent = (polled.events || []).find((event) =>
      event.method === "Network.responseReceived"
      && String(event.params?.response?.url || "").endsWith("/api/data")
    );
    if (!responseEvent?.params?.requestId) throw new Error("network response missing");
    const body = await call("tabward_network", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "body",
      request_id: responseEvent.params.requestId
    });
    if (!String(body.body).includes("frontend-qa-gate")) throw new Error("response body missing");
    await call("tabward_events", {
      session_id: sessionId, tab_id: tabId, operation: "stop"
    });
  });

  await check("dialog handling", async () => {
    const events = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "start",
      categories: ["dialog"]
    });
    await call("tabward_evaluate", {
      session_id: sessionId,
      tab_id: tabId,
      expression: "setTimeout(() => alert('TabWard QA dialog'), 0); true"
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const polled = await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "poll",
      cursor: events.cursor,
      categories: ["dialog"]
    });
    if (!(polled.events || []).some((event) => event.method === "Page.javascriptDialogOpening")) {
      throw new Error("dialog event missing");
    }
    await call("tabward_events", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "dialog",
      dialog_action: "dismiss"
    });
  });

  await check("upload", async () => {
    await call("tabward_upload", {
      session_id: sessionId,
      tab_id: tabId,
      locator: { selector: "#upload" },
      file_paths: [uploadPath]
    });
    await call("tabward_assert", {
      session_id: sessionId,
      tab_id: tabId,
      assertion: "text",
      locator: { selector: "#upload-result" },
      expected: basename(uploadPath)
    });
  });

  await check("download ownership and cleanup", async () => {
    const download = await call("tabward_download_click", {
      session_id: sessionId,
      tab_id: tabId,
      locator: { selector: "#download" },
      timeout_ms: 30_000
    });
    downloadId = download.downloadId;
    if (!Number.isInteger(downloadId) || download.verified !== true) {
      throw new Error(`download was not verified: ${JSON.stringify(download)}`);
    }
    await call("tabward_downloads", {
      session_id: sessionId,
      operation: "delete",
      download_id: downloadId
    });
    downloadId = null;
  });

  await check("drag and drop", async () => {
    await call("tabward_action", {
      session_id: sessionId,
      tab_id: tabId,
      action: "drag",
      locator: { selector: "#drag-source" },
      options: {
        targetLocator: { selector: "#drop-target" },
        dragData: "tabward"
      }
    });
    await call("tabward_assert", {
      session_id: sessionId,
      tab_id: tabId,
      assertion: "text",
      locator: { selector: "#drag-result" },
      expected: "tabward",
      timeout_ms: 5_000
    });
  });

  await check("SPA back and forward", async () => {
    await call("tabward_action", {
      session_id: sessionId,
      tab_id: tabId,
      action: "click",
      locator: { selector: "#history" }
    });
    await call("tabward_assert", {
      session_id: sessionId,
      tab_id: tabId,
      assertion: "url",
      expected: `${fixtureUrl}route-one`
    });
    await call("tabward_tabs", {
      session_id: sessionId, operation: "back", tab_id: tabId
    });
    await call("tabward_assert", {
      session_id: sessionId, tab_id: tabId, assertion: "url", expected: fixtureUrl
    });
    await call("tabward_tabs", {
      session_id: sessionId, operation: "forward", tab_id: tabId
    });
    await call("tabward_assert", {
      session_id: sessionId, tab_id: tabId, assertion: "url", expected: `${fixtureUrl}route-one`
    });
  });

  await check("trace artifact", async () => {
    await call("tabward_artifact", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "trace_start"
    });
    await call("tabward_evaluate", {
      session_id: sessionId,
      tab_id: tabId,
      expression: "Array.from({length: 1000}, (_, index) => index * 2).reduce((a, b) => a + b, 0)"
    });
    const trace = await call("tabward_artifact", {
      session_id: sessionId,
      tab_id: tabId,
      operation: "trace_stop",
      name: "frontend-qa-trace",
      options: { timeoutMs: 30_000 }
    });
    if (!trace.artifact?.path || trace.eventCount < 1) throw new Error("trace artifact missing");
    artifacts.push(trace.artifact.path);
  });

  await check("managed evaluate is loopback-only", async () => {
    const openedBlank = await call("tabward_tabs", {
      session_id: sessionId,
      operation: "open",
      url: "about:blank",
      active: false,
      wait: true
    });
    blankTabId = openedBlank.tab?.id;
    await expectFailure("tabward_evaluate", {
      session_id: sessionId,
      tab_id: blankTabId,
      expression: "1 + 1"
    }, /localhost|loopback/i);
  });

  if (Number.isInteger(blankTabId)) {
    await closeOwnedTab(blankTabId);
    blankTabId = null;
  }
  const closeResult = await closeOwnedTab(tabId);
  tabId = null;
  const listed = await call("tabward_tabs", {
    session_id: sessionId, operation: "list"
  });
  const leakedTabs = (listed.knownTabs || []).map((tab) => tab.id);
  const failures = checks.filter((item) => !item.ok);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: "TabWard",
    version: health.serverVersion,
    fixture: "local",
    checks,
    passed: checks.length - failures.length,
    failed: failures.length,
    callCount,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    leakedTabs,
    closeReconciled: closeResult.reconciled,
    gatePassed: failures.length === 0 && leakedTabs.length === 0
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.gatePassed) process.exitCode = 1;
} finally {
  if (Number.isInteger(downloadId) && sessionId) {
    await call("tabward_downloads", {
      session_id: sessionId,
      operation: "delete",
      download_id: downloadId
    }).catch(() => {});
  }
  for (const createdTabId of [blankTabId, tabId]) {
    if (Number.isInteger(createdTabId) && sessionId) {
      await closeOwnedTab(createdTabId).catch(() => {});
    }
  }
  if (sessionId) {
    await call("tabward_session_close", {
      session_id: sessionId,
      close_created_tabs: true
    }).catch(() => {});
  }
  await client.close().catch(() => {});
  await new Promise((resolveClose) => fixture.close(resolveClose));
  await rm(uploadPath, { force: true });
  for (const artifactPath of artifacts) {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
}
