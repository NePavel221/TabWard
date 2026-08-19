import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const expectedTools = [
  "tabward_health",
  "tabward_session_start",
  "tabward_session_list",
  "tabward_session_close",
  "tabward_tabs",
  "tabward_navigate",
  "tabward_observe",
  "tabward_action",
  "tabward_wait",
  "tabward_assert",
  "tabward_events",
  "tabward_network",
  "tabward_emulation",
  "tabward_storage",
  "tabward_artifact",
  "tabward_evaluate",
  "tabward_cdp",
  "tabward_downloads",
  "tabward_download_click"
];

test("fresh stdio server lists tools and returns health", { timeout: 15_000 }, async () => {
  const serverPath = resolve(import.meta.dirname, "..", "dist", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TABWARD_PORT: "0"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tabward-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), [...expectedTools].sort());

    const health = await client.callTool({
      name: "tabward_health",
      arguments: {}
    });
    assert.equal(health.isError, undefined);
    assert.equal(health.structuredContent.serverVersion, "0.1.0");
    assert.equal(health.structuredContent.bridge.host, "127.0.0.1");
    assert.equal(Number.isInteger(health.structuredContent.bridge.port), true);
    assert.equal(health.structuredContent.bridge.port > 0, true);
    assert.notEqual(health.structuredContent.bridge.port, 18766);
  } finally {
    await client.close();
  }
});
