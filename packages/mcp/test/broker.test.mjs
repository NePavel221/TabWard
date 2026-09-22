import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { BrokerClient, operationRequest } from "../dist/broker-client.js";
import { webSocketSendFailure } from "../dist/operation.js";

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

function fingerprint(command, payload) {
  return createHash("sha256")
    .update(JSON.stringify({ command, payload }))
    .digest("hex");
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
    base, child, headers, socket, token: approved.token,
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
    assert.equal(first.status, 409);
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
      assert.equal(message.operationId, "cccccccc-cccc-cccc-cccc-cccccccccccc");
      assert.match(message.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(typeof message.deadlineAt, "number");
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
      "schedulerActiveCount", "schedulerConfiguredMax", "schedulerMaxObservedActive",
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

test("different sessions overlap at scheduler max 2 while each session stays FIFO", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-stage3-overlap-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_TELEMETRY: "1",
      TABWARD_SCHEDULER_MAX_CONCURRENCY: "2"
    });
    const started = [];
    const completed = [];
    let active = 0;
    let maxActive = 0;
    fixture.socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(`${message.payload.sessionId}-${message.payload.sequence}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
      completed.push(`${message.payload.sessionId}-${message.payload.sequence}`);
      active -= 1;
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 2,
        ok: true,
        operationId: message.operationId,
        fingerprint: message.fingerprint,
        telemetry: { extensionExecutionMs: 35, outboxCommitMs: 0 },
        payload: message.payload
      }));
    });
    const inputs = [
      ["a", 1],
      ["a", 2],
      ["b", 1],
      ["c", 1]
    ];
    const responses = await Promise.all(inputs.map(([sessionId, sequence], index) =>
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          requestId: `${String(index + 40).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          command: "ping",
          payload: { sessionId, sequence },
          operationId: `${String(index + 40).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
          telemetry: true
        })
      }).then(async (response) => {
        assert.equal(response.status, 200);
        return await response.json();
      })
    ));
    assert.equal(maxActive, 2);
    assert.equal(started.indexOf("a-1") < started.indexOf("a-2"), true);
    assert.equal(completed.indexOf("a-1") < started.indexOf("a-2"), true);
    assert.equal(responses.every((value) =>
      value.telemetry.schedulerConfiguredMax === 2), true);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queued expiry is not dispatched to the extension", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-expiry-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    let sideEffects = 0;
    fixture.socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      sideEffects += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        operationId: message.operationId,
        fingerprint: message.fingerprint,
        protocolVersion: 2,
        ok: true,
        payload: { command: message.type }
      }));
    });
    const firstOperationId = "10000000-0000-4000-8000-000000000001";
    const secondOperationId = "10000000-0000-4000-8000-000000000002";
    const first = fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "10000000-0000-4000-8000-000000000011",
        operationId: firstOperationId,
        command: "ping",
        payload: { order: 1 },
        deadlineAt: Date.now() + 2_000
      })
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const second = fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "10000000-0000-4000-8000-000000000012",
        operationId: secondOperationId,
        command: "click",
        payload: { order: 2 },
        deadlineAt: Date.now() + 30
      })
    });
    assert.equal((await first).status, 200);
    const expired = await second;
    const value = await expired.json();
    assert.equal(expired.status, 409);
    assert.equal(value.name, "NotStarted");
    assert.equal(value.details.outcome, "not_started");
    assert.equal(sideEffects, 1);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("queued cancellation is acknowledged and has zero browser effects", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-cancel-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    let sideEffects = 0;
    fixture.socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      sideEffects += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        operationId: message.operationId,
        fingerprint: message.fingerprint,
        protocolVersion: 2,
        ok: true,
        payload: { ok: true }
      }));
    });
    const first = fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "20000000-0000-4000-8000-000000000011",
        operationId: "20000000-0000-4000-8000-000000000001",
        command: "ping",
        payload: {},
        deadlineAt: Date.now() + 2_000
      })
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const queuedOperationId = "20000000-0000-4000-8000-000000000002";
    const queued = fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "20000000-0000-4000-8000-000000000012",
        operationId: queuedOperationId,
        command: "click",
        payload: {},
        deadlineAt: Date.now() + 2_000
      })
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const cancel = await fetch(`${fixture.base}/cancel`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ operationId: queuedOperationId })
    }).then((response) => response.json());
    assert.equal(cancel.acknowledgement.state, "queued");
    assert.equal((await first).status, 200);
    const cancelled = await queued;
    const value = await cancelled.json();
    assert.equal(cancelled.status, 409);
    assert.equal(value.name, "CancelledBeforeEffect");
    assert.equal(value.details.effectPossible, false);
    assert.equal(sideEffects, 1);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("active cancellation is acknowledged without claiming effect-free completion", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-active-cancel-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    let activeMessage;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") {
        activeMessage = message;
        return;
      }
      if (message.kind === "cancel") {
        fixture.socket.send(JSON.stringify({
          kind: "cancel_ack",
          protocolVersion: 2,
          operationId: message.operationId,
          state: "active"
        }));
        fixture.socket.send(JSON.stringify({
          kind: "result",
          id: activeMessage.id,
          operationId: activeMessage.operationId,
          fingerprint: activeMessage.fingerprint,
          protocolVersion: 2,
          ok: false,
          payload: {
            name: "OutcomeUnknown",
            message: "active operation cancelled",
            details: {
              outcome: "effect_unknown",
              effectPossible: true,
              retrySafe: false
            }
          }
        }));
      }
    });
    const operationId = "21000000-0000-4000-8000-000000000002";
    const command = fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "21000000-0000-4000-8000-000000000012",
        operationId,
        command: "click",
        payload: {},
        deadlineAt: Date.now() + 2_000
      })
    });
    while (!activeMessage) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const cancel = await fetch(`${fixture.base}/cancel`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ operationId })
    }).then((response) => response.json());
    assert.equal(cancel.acknowledgement.state, "active");
    const response = await command;
    const value = await response.json();
    assert.equal(response.status, 422);
    assert.equal(value.name, "OutcomeUnknown");
    assert.equal(value.details.effectPossible, true);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("operation ledger joins duplicates and rejects fingerprint conflicts", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-dedupe-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    let dispatches = 0;
    fixture.socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      dispatches += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        operationId: message.operationId,
        fingerprint: message.fingerprint,
        protocolVersion: 2,
        ok: true,
        payload: { stable: true }
      }));
    });
    const operationId = "30000000-0000-4000-8000-000000000001";
    const command = "ping";
    const payload = { same: true };
    const body = (requestId) => JSON.stringify({
      requestId,
      operationId,
      command,
      payload,
      fingerprint: fingerprint(command, payload),
      deadlineAt: Date.now() + 2_000
    });
    const [first, second] = await Promise.all([
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: body("30000000-0000-4000-8000-000000000011")
      }).then((response) => response.json()),
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: body("30000000-0000-4000-8000-000000000012")
      }).then((response) => response.json())
    ]);
    assert.deepEqual(first.result, { stable: true });
    assert.deepEqual(second.result, { stable: true });
    assert.equal(dispatches, 1);
    const conflict = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "30000000-0000-4000-8000-000000000013",
        operationId,
        command: "tabs",
        payload: {},
        deadlineAt: Date.now() + 2_000
      })
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).name, "OperationConflict");
    assert.equal(dispatches, 1);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("disconnect after effect is unknown and never blindly redispatched", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-effect-loss-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    let dispatches = 0;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      dispatches += 1;
      fixture.socket.terminate();
    });
    const operationId = "40000000-0000-4000-8000-000000000001";
    const requestBody = (requestId) => JSON.stringify({
      requestId,
      operationId,
      command: "click",
      payload: { tabId: 1 },
      deadlineAt: Date.now() + 2_000
    });
    const first = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: requestBody("40000000-0000-4000-8000-000000000011")
    });
    assert.equal(first.status, 502);
    assert.equal((await first.json()).details.outcome, "effect_unknown");
    const second = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: requestBody("40000000-0000-4000-8000-000000000012")
    });
    assert.equal(second.status, 502);
    assert.equal(dispatches, 1);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent disconnect makes both effects unknown without duplicate dispatch", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-concurrent-loss-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_SCHEDULER_MAX_CONCURRENCY: "2"
    });
    let dispatches = 0;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      dispatches += 1;
      if (dispatches === 2) fixture.socket.terminate();
    });
    const deadlineAt = Date.now() + 5_000;
    const requests = [
      {
        requestId: "40500000-0000-4000-8000-000000000011",
        operationId: "40500000-0000-4000-8000-000000000001",
        command: "click",
        payload: { sessionId: "session-a", tabId: 1 },
        deadlineAt
      },
      {
        requestId: "40500000-0000-4000-8000-000000000012",
        operationId: "40500000-0000-4000-8000-000000000002",
        command: "click",
        payload: { sessionId: "session-b", tabId: 2 },
        deadlineAt
      }
    ];
    const first = await Promise.all(requests.map((body) =>
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify(body)
      })
    ));
    assert.deepEqual(first.map((response) => response.status), [502, 502]);
    for (const response of first) {
      assert.equal((await response.json()).details.outcome, "effect_unknown");
    }
    const replay = await Promise.all(requests.map((body, index) =>
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          ...body,
          requestId: `40500000-0000-4000-8000-00000000002${index + 1}`
        })
      })
    ));
    assert.deepEqual(replay.map((response) => response.status), [502, 502]);
    assert.equal(dispatches, 2);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a late confirmed result replaces a settled effect-unknown ledger entry", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-late-confirm-"));
  let fixture;
  let replaySocket;
  try {
    fixture = await startPairedBroker(stateDir);
    let dispatched;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      dispatched = message;
      fixture.socket.terminate();
    });
    const operationId = "41000000-0000-4000-8000-000000000001";
    const command = "click";
    const payload = { tabId: 7 };
    const operationFingerprint = fingerprint(command, payload);
    const body = (requestId) => JSON.stringify({
      requestId,
      operationId,
      command,
      payload,
      fingerprint: operationFingerprint,
      deadlineAt: Date.now() + 5_000
    });
    const first = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: body("41000000-0000-4000-8000-000000000011")
    });
    assert.equal(first.status, 502);
    assert.equal((await first.json()).details.outcome, "effect_unknown");
    assert.equal(dispatched.operationId, operationId);

    const health = await fetch(`${fixture.base}/health`, {
      headers: fixture.headers
    }).then((value) => value.json());
    replaySocket = await connectExtension(health.extension.port);
    replaySocket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.1",
      token: fixture.token
    }));
    assert.equal((await nextSocketMessage(replaySocket)).kind, "ready");
    replaySocket.send(JSON.stringify({
      kind: "result",
      id: dispatched.id,
      operationId,
      fingerprint: operationFingerprint,
      protocolVersion: 2,
      ok: true,
      payload: { recovered: "late" }
    }));
    assert.equal((await nextSocketMessage(replaySocket)).kind, "result_ack");
    const second = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: body("41000000-0000-4000-8000-000000000012")
    });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).result, { recovered: "late" });
  } finally {
    replaySocket?.terminate();
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("confirmed-result cache applies byte backpressure before acknowledgement", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-result-pressure-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_CONFIRMED_CACHE_BYTES: String(4 * 1024 * 1024)
    });
    fixture.socket.send(JSON.stringify({
      kind: "result",
      id: "42000000-0000-4000-8000-000000000001",
      operationId: "42000000-0000-4000-8000-000000000001",
      fingerprint: "a".repeat(64),
      protocolVersion: 2,
      ok: true,
      payload: { value: "x".repeat(5 * 1024 * 1024) }
    }));
    const reply = await nextSocketMessage(fixture.socket);
    assert.equal(reply.kind, "result_backpressure");
    assert.equal(reply.id, "42000000-0000-4000-8000-000000000001");
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("acknowledged pending results release confirmation-cache capacity", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-result-release-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_CONFIRMED_CACHE_BYTES: String(4 * 1024 * 1024)
    });
    const acknowledgements = [];
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") {
        fixture.socket.send(JSON.stringify({
          kind: "result",
          id: message.id,
          operationId: message.operationId,
          fingerprint: message.fingerprint,
          protocolVersion: 2,
          ok: true,
          payload: { value: "x".repeat(3 * 1024 * 1024) }
        }));
      } else if (message.kind === "result_ack" || message.kind === "result_backpressure") {
        acknowledgements.push(message.kind);
      }
    });
    for (const index of [0, 1]) {
      const response = await fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          requestId: `4250000${index}-0000-4000-8000-000000000011`,
          operationId: `4250000${index}-0000-4000-8000-000000000001`,
          command: "ping",
          payload: { index },
          deadlineAt: Date.now() + 5_000
        })
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    while (acknowledgements.length < 2) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.deepEqual(acknowledgements, ["result_ack", "result_ack"]);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent completions are acknowledged without lost cache updates", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-result-concurrent-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_CONFIRMED_CACHE_BYTES: String(8 * 1024 * 1024),
      TABWARD_SCHEDULER_MAX_CONCURRENCY: "4"
    });
    const acknowledgements = new Set();
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") {
        fixture.socket.send(JSON.stringify({
          kind: "result",
          id: message.id,
          operationId: message.operationId,
          fingerprint: message.fingerprint,
          protocolVersion: 2,
          ok: true,
          payload: { index: message.payload.index, value: "x".repeat(512 * 1024) }
        }));
      } else if (message.kind === "result_ack") {
        acknowledgements.add(message.id);
      }
    });
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          requestId: `4260000${index}-0000-4000-8000-000000000011`,
          operationId: `4260000${index}-0000-4000-8000-000000000001`,
          command: "ping",
          payload: { sessionId: `session-${index}`, index },
          deadlineAt: Date.now() + 5_000
        })
      })
    ));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    const deadline = Date.now() + 2_000;
    while (acknowledgements.size < 4 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.equal(acknowledgements.size, 4);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("read-only recovery request preserves identity and absolute deadline", () => {
  const deadlineAt = Date.now() + 5_000;
  const requestId = "43000000-0000-4000-8000-000000000011";
  const operationId = "43000000-0000-4000-8000-000000000001";
  const operation = operationRequest(
    "observe",
    { tabId: 1 },
    5_000,
    operationId,
    requestId,
    deadlineAt
  );
  const replay = operation;
  assert.equal(replay, operation);
  assert.equal(replay.requestId, requestId);
  assert.equal(replay.operationId, operationId);
  assert.equal(replay.deadlineAt, deadlineAt);
  assert.equal(replay.fingerprint, fingerprint("observe", { tabId: 1 }));
});

test("WebSocket send callback failures are post-dispatch ambiguous", () => {
  const error = webSocketSendFailure("synthetic callback failure");
  assert.equal(error.name, "OutcomeUnknown");
  assert.equal(error.details.outcome, "effect_unknown");
  assert.equal(error.details.effectPossible, true);
  assert.equal(error.details.retrySafe, false);
});

test("read-only broker restart reuses the original operation request", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "..", "src", "broker-client.ts"),
    "utf8"
  );
  assert.match(source, /body: JSON\.stringify\(operation\)/);
  assert.doesNotMatch(source, /return await this\.send\(command, payload/);
});

test("broker restart recovers a replayed durable extension result", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-replay-"));
  let fixture;
  let child;
  let socket;
  try {
    fixture = await startPairedBroker(stateDir);
    const token = fixture.token;
    await fixture.close();
    fixture = null;
    await unlink(resolve(stateDir, "runtime.json")).catch(() => {});
    const entry = resolve(import.meta.dirname, "..", "dist", "broker-server.js");
    child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        TABWARD_STATE_DIR: stateDir,
        TABWARD_PORT: "0",
        TABWARD_BROKER_PORT: "0",
        TABWARD_BROKER_EPHEMERAL: "1"
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
    socket = await connectExtension(health.extension.port);
    socket.send(JSON.stringify({
      kind: "hello",
      protocolVersion: 2,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionVersion: "0.3.1",
      token
    }));
    assert.equal((await nextSocketMessage(socket)).kind, "ready");
    const operationId = "50000000-0000-4000-8000-000000000001";
    const command = "click";
    const payload = { tabId: 1 };
    const operationFingerprint = fingerprint(command, payload);
    socket.send(JSON.stringify({
      kind: "result",
      id: operationId,
      operationId,
      fingerprint: operationFingerprint,
      protocolVersion: 2,
      ok: true,
      payload: { recovered: "confirmed" }
    }));
    assert.equal((await nextSocketMessage(socket)).kind, "result_ack");
    let redispatched = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") redispatched = true;
    });
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "50000000-0000-4000-8000-000000000011",
        operationId,
        command,
        payload,
        fingerprint: operationFingerprint,
        deadlineAt: Date.now() + 2_000
      })
    });
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(value.result, { recovered: "confirmed" });
    assert.equal(value.recovered, true);
    assert.equal(redispatched, false);
    await fetch(`${base}/shutdown`, { method: "POST", headers });
  } finally {
    await fixture?.close();
    socket?.terminate();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    if (child?.exitCode === null) child.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("broker byte budget fails before extension side effects", { timeout: 20_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-byte-budget-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir, {
      TABWARD_REQUEST_CACHE_BYTES: String(4 * 1024 * 1024)
    });
    let sideEffects = 0;
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "command") sideEffects += 1;
    });
    const response = await fetch(`${fixture.base}/command`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({
        requestId: "60000000-0000-4000-8000-000000000011",
        operationId: "60000000-0000-4000-8000-000000000001",
        command: "screenshot",
        payload: { tabId: 1 },
        deadlineAt: Date.now() + 2_000
      })
    });
    const value = await response.json();
    assert.equal(response.status, 507);
    assert.equal(value.details.outcome, "not_started");
    assert.equal(sideEffects, 0);
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("multi-megabyte read results fit reservations when capacity is free", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-broker-large-reads-"));
  let fixture;
  try {
    fixture = await startPairedBroker(stateDir);
    fixture.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      fixture.socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        operationId: message.operationId,
        fingerprint: message.fingerprint,
        protocolVersion: 2,
        ok: true,
        payload: { command: message.type, value: "x".repeat(3 * 1024 * 1024) }
      }));
    });
    for (const [index, command] of ["eventsPoll", "networkBody"].entries()) {
      const response = await fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          requestId: `6100000${index}-0000-4000-8000-000000000011`,
          operationId: `6100000${index}-0000-4000-8000-000000000001`,
          command,
          payload: { tabId: 1 },
          deadlineAt: Date.now() + 5_000
        })
      });
      assert.equal(response.status, 200, command);
      const value = await response.json();
      assert.equal(value.result.value.length, 3 * 1024 * 1024, command);
    }
  } finally {
    await fixture?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
