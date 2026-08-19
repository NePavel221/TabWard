import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { ExtensionBridge } from "../dist/bridge.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${extensionId}`;

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (value) => {
      try {
        resolve(JSON.parse(value.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function withTemporaryState(run) {
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const temporaryState = `${process.env.TEMP}\\tabward-test-${process.pid}-${Date.now()}`;
  process.env.LOCALAPPDATA = temporaryState;
  try {
    return await run();
  } finally {
    if (oldLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = oldLocalAppData;
    }
    await rm(temporaryState, { recursive: true, force: true });
  }
}

test("pairing code is exposed to MCP but not sent to the extension", { timeout: 10_000 }, async () => {
  await withTemporaryState(async () => {
    const bridge = new ExtensionBridge(0);
    await bridge.start();
    try {
      const socket = await connect(bridge.port);
      socket.send(JSON.stringify({
        kind: "hello",
        protocolVersion: 1,
        extensionId,
        extensionVersion: "0.1.0"
      }));
      const response = await nextMessage(socket);
      assert.equal(response.kind, "pairing_required");
      assert.equal("code" in response, false);
      assert.match(bridge.status().pairingCode, /^\d{6}$/);
      socket.terminate();
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
        protocolVersion: 1,
        extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        extensionVersion: "0.1.0"
      }));
      const closed = await new Promise((resolve) => {
        socket.once("close", (code) => resolve(code));
      });
      assert.equal(closed, 1008);
      assert.equal(bridge.status().state, "not_running");
    } finally {
      await bridge.stop();
    }
  });
});
