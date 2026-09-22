import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { ExtensionBridge } from "../dist/bridge.js";
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  PROTOCOL_VERSION,
  authenticateSocket,
  nextSocketMessage,
  pairSocket
} from "./handshake.mjs";

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: EXTENSION_ORIGIN
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function withTemporaryState(run) {
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const oldStateDir = process.env.TABWARD_STATE_DIR;
  const temporaryState = `${process.env.TEMP}\\tabward-test-${process.pid}-${Date.now()}`;
  process.env.LOCALAPPDATA = temporaryState;
  process.env.TABWARD_STATE_DIR = temporaryState;
  try {
    return await run(temporaryState);
  } finally {
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    if (oldStateDir === undefined) delete process.env.TABWARD_STATE_DIR;
    else process.env.TABWARD_STATE_DIR = oldStateDir;
    await rm(temporaryState, { recursive: true, force: true });
  }
}

test("pairing token is withheld until broker and extension prove the pairing code", { timeout: 20_000 }, async () => {
  await withTemporaryState(async (temporaryState) => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    try {
      const socket = await connect(bridge.port);
      const token = await pairSocket(socket, async () => bridge.status().pairingCode);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      const persisted = JSON.parse(await readFile(
        `${temporaryState}\\pairing.json`,
        "utf8"
      ));
      assert.equal(persisted.token, token);
      socket.close(1000);
    } finally {
      await bridge.stop();
    }
  });
});

test("fake loopback server never receives the reusable pairing token", { timeout: 20_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    let token;
    try {
      let socket = await connect(bridge.port);
      token = await pairSocket(socket, async () => bridge.status().pairingCode);
      socket.close(1000);
      await new Promise((resolveClose) => socket.once("close", resolveClose));
      socket = await connect(bridge.port);
      socket.send(JSON.stringify({
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionId: EXTENSION_ID,
        extensionVersion: "0.4.0",
        clientNonce: "a".repeat(43),
        hasPairingToken: true
      }));
      const challenge = await nextSocketMessage(socket);
      assert.equal(challenge.kind, "auth_challenge");
      assert.equal(JSON.stringify(challenge).includes(token), false);
      socket.terminate();
    } finally {
      await bridge.stop();
    }
  });
});

test("pre-auth sockets cannot mutate connected bridge identity or send results", { timeout: 20_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    let connected;
    let attacker;
    try {
      let pairing = await connect(bridge.port);
      const token = await pairSocket(pairing, async () => bridge.status().pairingCode);
      pairing.close(1000);
      await new Promise((resolveClose) => pairing.once("close", resolveClose));
      connected = await connect(bridge.port);
      await authenticateSocket(connected, token, "0.4.0");
      const before = bridge.status();
      attacker = await connect(bridge.port);
      attacker.send(JSON.stringify({
        kind: "result",
        protocolVersion: PROTOCOL_VERSION,
        id: "forged",
        operationId: "forged",
        fingerprint: "f".repeat(64),
        ok: true,
        payload: { forged: true }
      }));
      const code = await new Promise((resolveClose) =>
        attacker.once("close", resolveClose));
      assert.equal(code, 1008);
      assert.deepEqual(bridge.status(), before);
    } finally {
      connected?.terminate();
      attacker?.terminate();
      await bridge.stop();
    }
  });
});

test("unauthenticated version mismatch cannot replace an authenticated connection", { timeout: 20_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    let connected;
    let incompatible;
    try {
      let pairing = await connect(bridge.port);
      const token = await pairSocket(pairing, async () => bridge.status().pairingCode);
      pairing.close(1000);
      await new Promise((resolveClose) => pairing.once("close", resolveClose));
      connected = await connect(bridge.port);
      await authenticateSocket(connected, token);
      const before = bridge.status();

      incompatible = await connect(bridge.port);
      const mismatch = nextSocketMessage(incompatible);
      incompatible.send(JSON.stringify({
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION - 1,
        extensionId: EXTENSION_ID,
        extensionVersion: "0.3.1",
        clientNonce: "v".repeat(43),
        hasPairingToken: false
      }));
      assert.deepEqual(await mismatch, {
        kind: "version_mismatch",
        protocolVersion: PROTOCOL_VERSION
      });
      await new Promise((resolveClose) => incompatible.once("close", resolveClose));
      assert.deepEqual(bridge.status(), before);

      const pong = nextSocketMessage(connected);
      connected.send(JSON.stringify({
        kind: "ping",
        protocolVersion: PROTOCOL_VERSION
      }));
      assert.deepEqual(await pong, {
        kind: "pong",
        protocolVersion: PROTOCOL_VERSION
      });
    } finally {
      connected?.terminate();
      incompatible?.terminate();
      await bridge.stop();
    }
  });
});

test("oversized pre-auth payload is rejected before protocol parsing", { timeout: 10_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    try {
      const socket = await connect(bridge.port);
      socket.send("x".repeat(64 * 1024 + 1));
      const code = await new Promise((resolveClose) =>
        socket.once("close", resolveClose));
      assert.equal(code, 1008);
      assert.equal(bridge.status().state, "not_running");
    } finally {
      await bridge.stop();
    }
  });
});

test("pairing lockout survives reconnects and rotates the code after cooldown", { timeout: 30_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0, { pairingLockoutMs: 1_000 });
    await bridge.start();
    try {
      let originalCode = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const socket = await connect(bridge.port);
        const clientNonce = "b".repeat(42) + String(attempt);
        socket.send(JSON.stringify({
          kind: "hello",
          protocolVersion: PROTOCOL_VERSION,
          extensionId: EXTENSION_ID,
          extensionVersion: "0.4.0",
          clientNonce,
          hasPairingToken: false
        }));
        const challenge = await nextSocketMessage(socket);
        assert.equal(challenge.kind, "pairing_required");
        originalCode ??= bridge.status().pairingCode;
        socket.send(JSON.stringify({
          kind: "pairing_approve",
          protocolVersion: PROTOCOL_VERSION,
          code: "000000",
          connectionId: challenge.connectionId,
          clientNonce,
          serverNonce: challenge.serverNonce,
          extensionNonce: "c".repeat(43)
        }));
        await new Promise((resolveClose) => socket.once("close", resolveClose));
      }
      assert.match(originalCode, /^\d{6}$/);
      assert.equal(bridge.status().pairingCode, null);
      const blocked = await connect(bridge.port);
      blocked.send(JSON.stringify({
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionId: EXTENSION_ID,
        extensionVersion: "0.4.0",
        clientNonce: "d".repeat(43),
        hasPairingToken: false
      }));
      const code = await new Promise((resolveClose) =>
        blocked.once("close", resolveClose));
      assert.equal(code, 1008);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_050));
      const afterCooldown = await connect(bridge.port);
      afterCooldown.send(JSON.stringify({
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionId: EXTENSION_ID,
        extensionVersion: "0.4.0",
        clientNonce: "e".repeat(43),
        hasPairingToken: false
      }));
      assert.equal((await nextSocketMessage(afterCooldown)).kind, "pairing_required");
      assert.match(bridge.status().pairingCode, /^\d{6}$/);
      assert.notEqual(bridge.status().pairingCode, originalCode);
      afterCooldown.terminate();
    } finally {
      await bridge.stop();
    }
  });
});

test("extension id must match its Chrome origin", { timeout: 10_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    try {
      const socket = await connect(bridge.port);
      socket.send(JSON.stringify({
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        extensionVersion: "0.4.0",
        clientNonce: "e".repeat(43),
        hasPairingToken: false
      }));
      const closed = await new Promise((resolveClose) => {
        socket.once("close", resolveClose);
      });
      assert.equal(closed, 1008);
      assert.equal(bridge.status().state, "not_running");
    } finally {
      await bridge.stop();
    }
  });
});
