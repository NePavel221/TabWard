import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const expectedTools = [
  "tabward_health",
  "tabward_session_start",
  "tabward_session_list",
  "tabward_session_close",
  "tabward_tabs",
  "tabward_navigate",
  "tabward_observe",
  "tabward_action",
  "tabward_upload",
  "tabward_form",
  "tabward_wait",
  "tabward_assert",
  "tabward_events",
  "tabward_network",
  "tabward_emulation",
  "tabward_storage",
  "tabward_artifact",
  "tabward_evaluate",
  "tabward_probe",
  "tabward_qa",
  "tabward_cdp",
  "tabward_downloads",
  "tabward_download_click"
];

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.fail(`broker process ${pid} did not exit after stdio closed`);
}

function connectExtension(port) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    });
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

function nextSocketMessage(socket) {
  return new Promise((resolveMessage, reject) => {
    socket.once("message", (raw) => {
      try {
        resolveMessage(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

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
  const client = new Client({ name: "tabward-test", version: "0.3.0" });
  let brokerPid = null;
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
    assert.equal(health.structuredContent.serverVersion, "0.3.1");
    assert.equal(health.structuredContent.bridge.host, "127.0.0.1");
    assert.equal(Number.isInteger(health.structuredContent.bridge.port), true);
    assert.equal(health.structuredContent.bridge.port > 0, true);
    assert.notEqual(health.structuredContent.bridge.port, 18766);
    assert.equal(health._meta, undefined);
    brokerPid = health.structuredContent.bridge.broker.pid;
  } finally {
    await client.close();
    if (Number.isInteger(brokerPid)) await waitForProcessExit(brokerPid);
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
    new Client({ name: `tabward-multi-${index}`, version: "0.3.0" })
  );
  let brokerPid = null;
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
    brokerPid = health[0].structuredContent.bridge.broker.pid;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (Number.isInteger(brokerPid)) await waitForProcessExit(brokerPid);
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
  const client = new Client({ name: "tabward-recovery", version: "0.3.0" });
  let brokerPid = null;
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
    brokerPid = secondBroker.pid;
  } finally {
    await client.close();
    if (Number.isInteger(brokerPid)) await waitForProcessExit(brokerPid);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("opt-in MCP telemetry is returned only as health metadata", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-stdio-telemetry-"));
  const serverPath = resolve(import.meta.dirname, "..", "dist", "index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_STATE_DIR: stateDir,
      TABWARD_BROKER_EPHEMERAL: "1",
      TABWARD_TELEMETRY: "1"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "tabward-telemetry-test", version: "0.3.1" });
  let socket;
  let brokerPid = null;
  try {
    await client.connect(transport);
    let health = await client.callTool({ name: "tabward_health", arguments: {} });
    brokerPid = health.structuredContent.bridge.broker.pid;
    socket = await connectExtension(health.structuredContent.bridge.port);
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.1"
    }));
    assert.equal((await nextSocketMessage(socket)).kind, "pairing_required");
    health = await client.callTool({ name: "tabward_health", arguments: {} });
    socket.send(JSON.stringify({
      kind: "pairing_approve",
      protocolVersion: 2,
      code: health.structuredContent.bridge.pairingCode
    }));
    const approved = await nextSocketMessage(socket);
    socket.terminate();
    socket = await connectExtension(health.structuredContent.bridge.port);
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.1",
      token: approved.token
    }));
    assert.equal((await nextSocketMessage(socket)).kind, "ready");
    health = await client.callTool({ name: "tabward_health", arguments: {} });
    assert.equal(health.structuredContent.bridge.state, "connected");
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: true,
        operationId: message.operationId,
        telemetry: { extensionExecutionMs: 1, outboxCommitMs: 0 },
        payload: { ok: true, workspace: { kind: "group" } }
      }));
    });
    const started = await client.callTool({
      name: "tabward_session_start",
      arguments: { name: "telemetry-test", mode: "managed" }
    });
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent.ok, true);
    assert.equal(started.structuredContent.telemetry, undefined);
    assert.equal(started._meta, undefined);
    const measured = await client.callTool({ name: "tabward_health", arguments: {} });
    const samples = measured._meta["tabward/telemetry"];
    assert.equal(samples.length, 1);
    assert.match(samples[0].operationId, /^[a-f0-9-]{36}$/i);
    assert.equal(samples[0].operationType, "nameSession");
    assert.equal(typeof samples[0].clientTotalMs, "number");
    assert.doesNotMatch(JSON.stringify(samples), /telemetry-test|workspace|group/i);
  } finally {
    socket?.terminate();
    await client.close();
    if (Number.isInteger(brokerPid)) await waitForProcessExit(brokerPid);
    await rm(stateDir, { recursive: true, force: true });
  }
});
