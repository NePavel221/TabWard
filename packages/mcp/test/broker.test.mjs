import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

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
