import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

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
