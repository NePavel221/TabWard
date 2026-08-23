import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reportDir = resolve(root, ".factory", "temp");
const reportPath = resolve(reportDir, "clean-qa-gate.json");
const serverPath = resolve(root, "packages", "mcp", "dist", "index.js");
const fixture = createServer((_request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end("<!doctype html><title>TabWard Clean QA fixture</title><h1>Clean QA fixture</h1>");
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: "pipe"
});
const client = new Client({ name: "tabward-clean-qa-gate", version: "0.3.0" });
let primarySessionId = null;
let verificationSessionId = null;
const checks = [];

function structured(result, name) {
  if (result?.isError === true || !result?.structuredContent) {
    const text = result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    throw new Error(text || `${name} returned no structured content`);
  }
  return result.structuredContent;
}

async function call(name, args = {}, timeout = 90_000) {
  return structured(await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout, maxTotalTimeout: timeout }
  ), name);
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
  while (Date.now() < deadline) {
    const health = await call("tabward_health");
    if (health.ok === true) return health;
    if (health.bridge?.state === "pairing_required") throw new Error("TabWard pairing is required");
    if (health.bridge?.state === "version_mismatch") throw new Error("TabWard version mismatch");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("TabWard did not become ready");
}

await mkdir(reportDir, { recursive: true });
await new Promise((resolveListen) => fixture.listen(0, "127.0.0.1", resolveListen));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;

try {
  await client.connect(transport);
  const health = await waitForReady();

  await check("clean session preflight", async () => {
    const started = await call("tabward_session_start", {
      mode: "managed",
      clean_qa: true,
      name: "Clean QA gate",
      ttl_seconds: 300
    });
    primarySessionId = started.session?.sessionId;
    if (!primarySessionId) throw new Error("clean session returned no session ID");
    if (started.session.cleanQa !== true || started.session.cleanQaTainted !== false) {
      throw new Error(`unexpected clean session state: ${JSON.stringify(started.session)}`);
    }
    if (started.session.workspace !== "isolated") {
      throw new Error("Clean QA did not force an isolated workspace");
    }
  });

  await check("second clean session is rejected", async () => {
    try {
      await call("tabward_session_start", {
        mode: "managed",
        clean_qa: true,
        name: "Competing Clean QA gate",
        ttl_seconds: 300
      });
    } catch (error) {
      if (/already active|unavailable/i.test(String(error?.message || error))) return;
      throw error;
    }
    throw new Error("a competing Clean QA session unexpectedly started");
  });

  await check("clean incognito workspace", async () => {
    const opened = await call("tabward_tabs", {
      session_id: primarySessionId,
      operation: "open",
      url: fixtureUrl,
      active: false,
      wait: true
    });
    const tabId = opened.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error("Clean QA open returned no tab ID");
    if (opened.cleanQa?.clean !== true || opened.cleanQa?.tainted === true) {
      throw new Error(`Clean QA workspace is not clean: ${JSON.stringify(opened.cleanQa)}`);
    }
    if (opened.workspace !== "isolated" || !Number.isInteger(opened.workspaceWindowId)) {
      throw new Error("Clean QA did not return its isolated window");
    }
    const observed = await call("tabward_observe", {
      session_id: primarySessionId,
      tab_id: tabId,
      mode: "state",
      max_chars: 10_000
    });
    if (!String(observed.title || "").includes("TabWard Clean QA fixture")) {
      throw new Error(`unexpected Clean QA title: ${String(observed.title || "")}`);
    }
    const listed = await call("tabward_tabs", {
      session_id: primarySessionId,
      operation: "list"
    });
    if (listed.cleanQa?.clean !== true || listed.cleanQa?.tainted === true) {
      throw new Error(`Clean QA became tainted: ${JSON.stringify(listed.cleanQa)}`);
    }
  });

  await check("owned incognito cleanup", async () => {
    const closed = await call("tabward_session_close", {
      session_id: primarySessionId,
      close_created_tabs: false
    });
    primarySessionId = null;
    if (closed.cleanup?.cleanQa?.closed !== true) {
      throw new Error(`Clean QA cleanup was not confirmed: ${JSON.stringify(closed.cleanup)}`);
    }
    if ((closed.cleanup.cleanQa.foreignTabsPreserved || []).length !== 0) {
      throw new Error("Clean QA cleanup found foreign incognito tabs");
    }
  });

  await check("clean state can restart", async () => {
    const started = await call("tabward_session_start", {
      mode: "managed",
      clean_qa: true,
      name: "Clean QA restart verification",
      ttl_seconds: 300
    });
    verificationSessionId = started.session?.sessionId;
    if (!verificationSessionId || started.session.cleanQaTainted === true) {
      throw new Error("Clean QA could not restart after cleanup");
    }
    await call("tabward_session_close", {
      session_id: verificationSessionId,
      close_created_tabs: false
    });
    verificationSessionId = null;
  });

  const failures = checks.filter((item) => !item.ok);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: "TabWard",
    version: health.serverVersion,
    checks,
    passed: checks.length - failures.length,
    failed: failures.length,
    gatePassed: failures.length === 0
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }));
  if (!report.gatePassed) process.exitCode = 1;
} finally {
  for (const sessionId of [verificationSessionId, primarySessionId]) {
    if (sessionId) {
      await call("tabward_session_close", {
        session_id: sessionId,
        close_created_tabs: true
      }).catch(() => {});
    }
  }
  await client.close().catch(() => {});
  await new Promise((resolveClose) => fixture.close(resolveClose));
}
