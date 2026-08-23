import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-stdio-"));
  const serverPath = resolve(import.meta.dirname, "..", "dist", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_STATE_DIR: stateDir,
      TABWARD_BROKER_EPHEMERAL: "1"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tabward-test", version: "0.2.0" });
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
    assert.equal(health.structuredContent.serverVersion, "0.2.0");
    assert.equal(health.structuredContent.bridge.host, "127.0.0.1");
    assert.equal(Number.isInteger(health.structuredContent.bridge.port), true);
    assert.equal(health.structuredContent.bridge.port > 0, true);
    assert.notEqual(health.structuredContent.bridge.port, 18766);
  } finally {
    await client.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("two stdio clients share one persistent broker", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-multi-"));
  const serverPath = resolve(import.meta.dirname, "..", "dist", "index.js");
  const env = {
    ...process.env,
    TABWARD_PORT: "0",
    TABWARD_BROKER_PORT: "0",
    TABWARD_STATE_DIR: stateDir,
    TABWARD_BROKER_EPHEMERAL: "1"
  };
  const transports = [0, 1].map(() => new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    stderr: "pipe"
  }));
  const clients = transports.map((_, index) =>
    new Client({ name: `tabward-multi-${index}`, version: "0.2.0" })
  );
  try {
    await Promise.all(clients.map((client, index) => client.connect(transports[index])));
    const health = await Promise.all(clients.map((client) => client.callTool({
      name: "tabward_health",
      arguments: {}
    })));
    const instances = health.map((result) =>
      result.structuredContent.bridge.broker.instanceId
    );
    assert.equal(typeof instances[0], "string");
    assert.deepEqual(instances[0], instances[1]);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("health restarts a terminated broker", { timeout: 25_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-recovery-"));
  const serverPath = resolve(import.meta.dirname, "..", "dist", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_STATE_DIR: stateDir,
      TABWARD_BROKER_EPHEMERAL: "1"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tabward-recovery", version: "0.2.0" });
  try {
    await client.connect(transport);
    const first = await client.callTool({
      name: "tabward_health",
      arguments: {}
    });
    const firstBroker = first.structuredContent.bridge.broker;
    assert.equal(typeof firstBroker.instanceId, "string");
    process.kill(Number(firstBroker.pid));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    const second = await client.callTool({
      name: "tabward_health",
      arguments: {}
    });
    const secondBroker = second.structuredContent.bridge.broker;
    assert.equal(typeof secondBroker.instanceId, "string");
    assert.notEqual(secondBroker.instanceId, firstBroker.instanceId);
  } finally {
    await client.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await rm(stateDir, { recursive: true, force: true });
  }
});
