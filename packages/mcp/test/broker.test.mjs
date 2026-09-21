import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { BrokerClient } from "../dist/broker-client.js";

async function waitForRuntime(stateDir) {
  const path = resolve(stateDir, "runtime.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error("broker runtime was not written");
}

function connectExtension(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    });
    socket.once("open", () => resolve(socket));
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

async function startPairedBroker(stateDir, extraEnv = {}) {
  const entry = resolve(import.meta.dirname, "..", "dist", "broker-server.js");
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TABWARD_STATE_DIR: stateDir,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_BROKER_EPHEMERAL: "1",
      ...extraEnv
    },
    stdio: "ignore"
  });
  const runtime = await waitForRuntime(stateDir);
  const base = `http://${runtime.host}:${runtime.port}`;
  const headers = {
    Authorization: `Bearer ${runtime.token}`,
    "Content-Type": "application/json"
  };
  const health = await fetch(`${base}/health`, { headers }).then((value) => value.json());
  let socket = await connectExtension(health.extension.port);
  socket.send(JSON.stringify({
    kind: "hello",
    protocolVersion: 2,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionVersion: "0.3.1"
  }));
  assert.equal((await nextSocketMessage(socket)).kind, "pairing_required");
  const pairingHealth = await fetch(`${base}/health`, { headers }).then((value) => value.json());
  socket.send(JSON.stringify({
    kind: "pairing_approve",
    protocolVersion: 2,
    code: pairingHealth.extension.pairingCode
  }));
  const approved = await nextSocketMessage(socket);
  assert.equal(approved.kind, "pairing_approved");
  socket.terminate();
  socket = await connectExtension(health.extension.port);
  socket.send(JSON.stringify({
    kind: "hello",
    protocolVersion: 2,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionVersion: "0.3.1",
    token: approved.token
  }));
  assert.equal((await nextSocketMessage(socket)).kind, "ready");
  return {
    base, child, headers, socket,
    close: async () => {
      socket.terminate();
      await fetch(`${base}/shutdown`, { method: "POST", headers }).catch(() => {});
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      if (child.exitCode === null) child.kill();
    }
  };
}

test("broker authenticates health and rejects reused request content", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-"));
  const entry = resolve(import.meta.dirname, "..", "dist", "broker-server.js");
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TABWARD_STATE_DIR: stateDir,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_BROKER_EPHEMERAL: "1"
    },
    stdio: "ignore"
  });
  try {
    const runtime = await waitForRuntime(stateDir);
    const base = `http://${runtime.host}:${runtime.port}`;
    const unauthorized = await fetch(`${base}/health`);
    assert.equal(unauthorized.status, 401);
    const headers = {
      Authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json"
    };
    const first = await fetch(`${base}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        command: "ping",
        payload: {}
      })
    });
    assert.equal(first.status, 502);
    const conflict = await fetch(`${base}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        command: "tabs",
        payload: {}
      })
    });
    assert.equal(conflict.status, 409);
    await fetch(`${base}/shutdown`, { method: "POST", headers });
  } finally {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    if (child.exitCode === null) child.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("broker returns deterministic extension errors as 422", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-error-"));
  const entry = resolve(import.meta.dirname, "..", "dist", "broker-server.js");
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TABWARD_STATE_DIR: stateDir,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_BROKER_EPHEMERAL: "1"
    },
    stdio: "ignore"
  });
  let socket;
  try {
    const runtime = await waitForRuntime(stateDir);
    const base = `http://${runtime.host}:${runtime.port}`;
    const headers = {
      Authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json"
    };
    const health = await fetch(`${base}/health`, { headers }).then((value) => value.json());
    socket = await connectExtension(health.extension.port);
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.0"
    }));
    const pairingRequired = await nextSocketMessage(socket);
    assert.equal(pairingRequired.kind, "pairing_required");
    const pairingHealth = await fetch(`${base}/health`, { headers }).then((value) => value.json());
    socket.send(JSON.stringify({
      kind: "pairing_approve",
      protocolVersion: 2,
      code: pairingHealth.extension.pairingCode
    }));
    const pairingApproved = await nextSocketMessage(socket);
    assert.equal(pairingApproved.kind, "pairing_approved");
    const paired = pairingApproved.token;
    socket.terminate();
    socket = await connectExtension(health.extension.port);
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.0",
      token: paired
    }));
    const ready = await nextSocketMessage(socket);
    assert.equal(ready.kind, "ready");
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: false,
        payload: { name: "OwnershipError", message: "tab is not owned" }
      }));
    });
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        command: "closeTab",
        payload: { tabId: 42 }
      })
    });
    assert.equal(response.status, 422);
    const value = await response.json();
    assert.equal(value.name, "OwnershipError");
    assert.equal(value.error, "tab is not owned");
    await fetch(`${base}/shutdown`, { method: "POST", headers });
  } finally {
    socket?.terminate();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    if (child.exitCode === null) child.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("telemetry is absent by default when the operation does not opt in", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-no-telemetry-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      assert.equal(message.operationId, undefined);
      assert.equal(message.telemetry, undefined);
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: true,
        payload: { ok: true }
      }));
    });
    const response = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        command: "ping",
        payload: { url: "https://secret.example", value: "private" }
      })
    });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.telemetry, undefined);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("telemetry correlates broker, bridge, and extension without sensitive payload fields", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-telemetry-"));
  let fixture;
  try {
    // Regression: the long-lived broker itself was started with telemetry off.
    // The authenticated client opts this individual operation in.
    fixture = await startPairedBroker(stateDir, { TABWARD_TELEMETRY: "0" });
    const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    fixture.socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      assert.equal(message.operationId, operationId);
      assert.equal(message.telemetry, true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: true,
        operationId,
        telemetry: {
          extensionExecutionMs: 10,
          outboxCommitMs: 2,
          url: "https://secret.example/private",
          selector: "#password",
          value: "hunter2",
          result: "private page"
        },
        payload: { ok: true, value: "normal command result" }
      }));
    });
    const response = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        command: "fill",
        payload: {
          url: "https://secret.example/private",
          selector: "#password",
          value: "hunter2",
          filePath: "C:\\private\\document.pdf"
        },
        operationId,
        telemetry: true
      })
    });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.result.value, "normal command result");
    assert.equal(value.telemetry.operationId, operationId);
    assert.equal(value.telemetry.operationType, "fill");
    for (const key of [
      "brokerActiveRequests", "brokerQueueDepth", "bridgeQueueWaitMs",
      "bridgeRoundTripMs", "extensionExecutionMs", "outboxCommitMs",
      "transferResidualMs", "brokerTotalMs", "resultBytes", "brokerRssBytes"
    ]) {
      assert.equal(typeof value.telemetry[key], "number", key);
    }
    assert.doesNotMatch(
      JSON.stringify(value.telemetry),
      /secret|password|hunter2|private|document|normal command result/i
    );
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("typed download OutcomeUnknown reaches the caller once without automatic retry", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-download-unknown-"));
  const oldStateDir = process.env.TABWARD_STATE_DIR;
  const oldPort = process.env.TABWARD_PORT;
  const oldBrokerPort = process.env.TABWARD_BROKER_PORT;
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    process.env.TABWARD_STATE_DIR = stateDir;
    process.env.TABWARD_PORT = "0";
    process.env.TABWARD_BROKER_PORT = "0";
    let sideEffects = 0;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      sideEffects += 1;
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: false,
        payload: {
          name: "OutcomeUnknown",
          message: "Download click was accepted but no result was confirmed",
          details: {
            kind: "download",
            phase: "post_click_timeout",
            actionAccepted: true,
            reservationHeld: true,
            retrySafe: false
          }
        }
      }));
    });
    const client = new BrokerClient();
    await client.start();
    await assert.rejects(
      client.send("downloadClick", { sessionId: "session-a", tabId: 1 }, 1_000),
      (error) => {
        assert.equal(error?.name, "OutcomeUnknown");
        assert.deepEqual(error?.details, {
          kind: "download",
          phase: "post_click_timeout",
          actionAccepted: true,
          reservationHeld: true,
          retrySafe: false
        });
        return true;
      }
    );
    assert.equal(sideEffects, 1);
  } finally {
    if (oldStateDir === undefined) delete process.env.TABWARD_STATE_DIR;
    else process.env.TABWARD_STATE_DIR = oldStateDir;
    if (oldPort === undefined) delete process.env.TABWARD_PORT;
    else process.env.TABWARD_PORT = oldPort;
    if (oldBrokerPort === undefined) delete process.env.TABWARD_BROKER_PORT;
    else process.env.TABWARD_BROKER_PORT = oldBrokerPort;
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

for (const clients of [2, 4]) {
  test(`${clients} simultaneous broker clients execute through the global sequential queue`, { timeout: 20_000 }, async () => {
    const stateDir = await mkdtemp(resolve(tmpdir(), `tabward-broker-queue-${clients}-`));
    let fixture;
    try {
      fixture = await startPairedBroker(stateDir, { TABWARD_TELEMETRY: "1" });
      const started = [];
      const completed = [];
      let active = 0;
      let maxActive = 0;
      fixture.socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind !== "command") return;
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(message.payload.client);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
        completed.push(message.payload.client);
        active -= 1;
        fixture.socket.send(JSON.stringify({
          kind: "result",
          id: message.id,
          protocolVersion: 2,
          ok: true,
          operationId: message.operationId,
          telemetry: { extensionExecutionMs: 35, outboxCommitMs: 0 },
          payload: { client: message.payload.client }
        }));
      });
      const responses = await Promise.all(Array.from({ length: clients }, (_, index) =>
        fetch(`${fixture.base}/command`, {
          method: "POST",
          headers: fixture.headers,
          body: JSON.stringify({
            requestId: `${String(index + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
            command: "ping",
            payload: { client: index },
            operationId: `${String(index + 1).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
            telemetry: true
          })
        }).then((response) => response.json())
      ));
      assert.equal(maxActive, 1);
      assert.deepEqual(completed, started);
      assert.equal(responses.every((value) => value.result.client >= 0), true);
      const waits = responses.map((value) => value.telemetry.bridgeQueueWaitMs);
      assert.equal(waits.filter((value) => value >= 25).length, clients - 1);
    } finally {
      await fixture?.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
