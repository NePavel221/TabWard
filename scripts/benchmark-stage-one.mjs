import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import {
  authenticateSocket,
  pairSocket
} from "../packages/mcp/test/handshake.mjs";

const root = resolve(import.meta.dirname, "..");
const brokerEntry = resolve(root, "packages", "mcp", "dist", "broker-server.js");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const commandDelayMs = Math.max(10, Number(process.env.TABWARD_BENCH_DELAY_MS || 80));
const samplesPerClient = Math.max(2, Number(process.env.TABWARD_BENCH_SAMPLES || 12));

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    p50: Number(percentile(values, 0.50).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2))
  };
}

async function waitForRuntime(stateDir) {
  const path = resolve(stateDir, "runtime.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("benchmark broker runtime was not written");
}

function connectExtension(port) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: `chrome-extension://${extensionId}`
    });
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

async function stopChild(child) {
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  if (stopped()) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
  ]);
  if (!stopped()) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
    ]);
  }
  if (!stopped()) {
    throw new Error(`Benchmark child ${child.pid} did not exit`);
  }
}

async function cleanupFixture({ socket, base, headers, child, stateDir }) {
  socket?.terminate();
  if (base && headers) {
    await fetch(`${base}/shutdown`, { method: "POST", headers }).catch(() => {});
  }
  try {
    await stopChild(child);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function startFixture(maxConcurrency) {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-stage3-benchmark-"));
  const child = spawn(process.execPath, [brokerEntry], {
    env: {
      ...process.env,
      TABWARD_STATE_DIR: stateDir,
      TABWARD_PORT: "0",
      TABWARD_BROKER_PORT: "0",
      TABWARD_BROKER_EPHEMERAL: "1",
      TABWARD_TELEMETRY: "1",
      TABWARD_SCHEDULER_MAX_CONCURRENCY: String(maxConcurrency)
    },
    stdio: "ignore"
  });
  let base;
  let headers;
  let socket;
  try {
    if (process.env.TABWARD_BENCH_FAIL_AFTER_SPAWN === "1") {
      throw new Error(`Injected benchmark fixture failure for child ${child.pid}`);
    }
    const runtime = await waitForRuntime(stateDir);
    base = `http://${runtime.host}:${runtime.port}`;
    headers = {
      Authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json"
    };
    const health = await fetch(`${base}/health`, { headers }).then((value) => value.json());
    socket = await connectExtension(health.extension.port);
    const token = await pairSocket(socket, async () => {
      const pairing = await fetch(`${base}/health`, { headers }).then((value) => value.json());
      return pairing.extension.pairingCode;
    });
    socket.close(1000);
    await new Promise((resolveClose) => socket.once("close", resolveClose));
    socket = await connectExtension(health.extension.port);
    await authenticateSocket(socket, token);
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind !== "command") return;
      const startedAt = performance.now();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, commandDelayMs));
      socket.send(JSON.stringify({
        kind: "result",
        id: message.id,
        protocolVersion: 3,
        ok: true,
        operationId: message.operationId,
        telemetry: {
          extensionExecutionMs: performance.now() - startedAt,
          outboxCommitMs: 0
        },
        payload: { ok: true, client: message.payload.client, sequence: message.payload.sequence }
      }));
    });
    return {
      base, headers, stateDir, child, socket,
      close: async () => cleanupFixture({ socket, base, headers, child, stateDir })
    };
  } catch (error) {
    await cleanupFixture({ socket, base, headers, child, stateDir });
    throw error;
  }
}

async function runScenario(fixture, clients, maxConcurrency) {
  const samples = [];
  for (let sequence = 0; sequence < samplesPerClient; sequence += 1) {
    const burst = Array.from({ length: clients }, async (_, client) => {
      const operationId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const startedAt = performance.now();
      const response = await fetch(`${fixture.base}/command`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          requestId,
          command: "ping",
          payload: {
            client,
            sequence,
            sessionId: `benchmark-session-${client}`
          },
          operationId,
          telemetry: true
        })
      });
      const value = await response.json();
      assert.equal(response.status, 200);
      assert.equal(value.telemetry.operationId, operationId);
      samples.push({
        client,
        wallMs: performance.now() - startedAt,
        ...value.telemetry
      });
    });
    await Promise.all(burst);
  }
  const queueWait = samples.map((sample) => sample.bridgeQueueWaitMs);
  const execution = samples.map((sample) => sample.extensionExecutionMs);
  const total = samples.map((sample) => sample.brokerTotalMs);
  const resultBytes = samples.map((sample) => sample.resultBytes);
  const rss = samples.map((sample) => sample.brokerRssBytes);
  const clientTotals = Array.from({ length: clients }, (_, client) =>
    samples
      .filter((sample) => sample.client === client)
      .map((sample) => sample.brokerTotalMs)
  );
  const clientP95 = clientTotals.map((values) => percentile(values, 0.95));
  return {
    maxConcurrency,
    clients,
    samples: samples.length,
    queueWaitMs: summarize(queueWait),
    executionMs: summarize(execution),
    totalMs: summarize(total),
    wallMs: summarize(samples.map((sample) => sample.wallMs)),
    resultBytes: summarize(resultBytes),
    rssBytes: summarize(rss),
    maxObservedQueueDepth: Math.max(...samples.map((sample) => sample.brokerQueueDepth)),
    maxObservedActive: Math.max(...samples.map((sample) =>
      sample.schedulerMaxObservedActive || sample.schedulerActiveCount || 0)),
    fairnessP95Ratio: Number((
      Math.max(...clientP95) / Math.max(0.001, Math.min(...clientP95))
    ).toFixed(2)),
    holAmplificationP50: Number((percentile(total, 0.50) / percentile(execution, 0.50)).toFixed(2))
  };
}

const results = [];
for (const maxConcurrency of [1, 2, 4]) {
  const fixture = await startFixture(maxConcurrency);
  try {
    for (const clients of [1, 2, 4]) {
      results.push(await runScenario(fixture, clients, maxConcurrency));
    }
  } finally {
    await fixture.close();
  }
}
console.log(JSON.stringify({
  benchmark: "TabWard Stage Three bounded fair scheduler",
  commandDelayMs,
  samplesPerClient,
  ports: "dynamic loopback only",
  baselineStageTwoP95Ms: { clients1: 93.19, clients2: 186.19, clients4: 371.37 },
  results
}, null, 2));
