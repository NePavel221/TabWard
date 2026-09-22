#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ExtensionBridge, ExtensionCommandError } from "./bridge.js";
import {
  commandFingerprint,
  OperationFailure,
  remainingMs,
  type OperationDescriptor
} from "./operation.js";
import { writeRuntime } from "./runtime.js";
import { newTelemetry, sanitizeTelemetry, validOperationId, type OperationTelemetry } from "./telemetry.js";

const HOST = "127.0.0.1";
const IPC_PORT = Number(process.env.TABWARD_BROKER_PORT || 18767);
const EXTENSION_PORT = Number(process.env.TABWARD_PORT || 18766);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const instanceId = randomUUID();
const bridge = new ExtensionBridge(EXTENSION_PORT);
let token = "";
let clients = 0;
const requests = new Map<string, {
  createdAt: number;
  fingerprint: string;
  promise: Promise<unknown>;
  settled: boolean;
  reservedBytes: number;
  actualBytes: number;
  deadlineAt: number;
  telemetry?: OperationTelemetry;
  settledError?: unknown;
}>();
const REQUEST_TTL_MS = 60 * 60_000;
const MAX_CACHED_REQUESTS = 256;
const MAX_REQUEST_CACHE_BYTES = Math.max(
  4 * 1024 * 1024,
  Number(process.env.TABWARD_REQUEST_CACHE_BYTES || 32 * 1024 * 1024)
);
let requestCacheBytes = 0;

function authorized(value: string | undefined): boolean {
  if (!value || !token) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reserveBytes(command: string, payload: Record<string, unknown>): number {
  const requestBytes = Buffer.byteLength(JSON.stringify({ command, payload }));
  if (["screenshot", "traceStop", "screencastFrame"].includes(command)) {
    return requestBytes + 16 * 1024 * 1024;
  }
  if ([
    "observe", "snapshot", "queryRich", "getText", "getHtml",
    "extractTables", "extractImages", "eventsPoll", "networkBody",
    "networkHar", "storage", "qa"
  ].includes(command)) {
    return requestBytes + 8 * 1024 * 1024;
  }
  return requestBytes + 1024 * 1024;
}

function removeRequest(id: string): void {
  const record = requests.get(id);
  if (!record) return;
  requestCacheBytes = Math.max(
    0,
    requestCacheBytes - Math.max(record.reservedBytes, record.actualBytes)
  );
  requests.delete(id);
}

function pruneRequests(now = Date.now()): void {
  for (const [id, record] of requests) {
    if (now - record.createdAt > REQUEST_TTL_MS && record.settled) removeRequest(id);
  }
}

function evictSettled(requiredBytes: number): void {
  while (
    requests.size >= MAX_CACHED_REQUESTS
    || requestCacheBytes + requiredBytes > MAX_REQUEST_CACHE_BYTES
  ) {
    const removable = [...requests.entries()]
      .filter(([, candidate]) => candidate.settled)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!removable) return;
    removeRequest(removable[0]);
  }
}

function confirmedPromise(
  result: NonNullable<ReturnType<ExtensionBridge["confirmedResult"]>>
): Promise<unknown> | null {
  if (result === "conflict") return null;
  if (result.ok) return Promise.resolve(result.payload);
  const failure = typeof result.payload === "object" && result.payload !== null
    ? result.payload as { name?: unknown; message?: unknown; details?: unknown }
    : {};
  return Promise.reject(new ExtensionCommandError(
    typeof failure.message === "string"
      ? failure.message
      : "Recovered extension command failed",
    typeof failure.name === "string" ? failure.name : "ExtensionCommandError",
    failure.details
  ));
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  if (request.headers.host !== `${HOST}:${(server.address() as AddressInfo | null)?.port}`) {
    json(response, 400, { ok: false, error: "invalid host" });
    return;
  }
  if (!authorized(request.headers.authorization?.replace(/^Bearer /, ""))) {
    json(response, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, {
      ok: true,
      brokerVersion: "0.3.1",
      pid: process.pid,
      instanceId,
      uptimeSeconds: Math.floor(process.uptime()),
      activeRequests: clients,
      scheduler: bridge.queueStatus(),
      extension: { host: bridge.host, port: bridge.port, ...bridge.status() }
    });
    return;
  }
  if (
    request.method === "POST"
    && request.url === "/shutdown"
    && process.env.TABWARD_BROKER_EPHEMERAL === "1"
  ) {
    json(response, 200, { ok: true });
    setImmediate(() => shutdown());
    return;
  }
  if (request.method !== "POST" || !["/command", "/cancel"].includes(request.url || "")) {
    json(response, 404, { ok: false, error: "not found" });
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  let oversized = false;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      oversized = true;
      request.destroy();
    }
    else chunks.push(chunk);
  });
  request.on("end", async () => {
    if (oversized) return;
    clients += 1;
    let metrics: OperationTelemetry | undefined;
    let recovered = false;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        requestId?: string;
        command?: string;
        payload?: Record<string, unknown>;
        timeoutMs?: number;
        operationId?: string;
        fingerprint?: string;
        deadlineAt?: number;
        telemetry?: boolean;
      };
      if (request.url === "/cancel") {
        if (!body.operationId || !/^[a-f0-9-]{16,80}$/i.test(body.operationId)) {
          json(response, 400, { ok: false, error: "valid operationId is required" });
          return;
        }
        const acknowledgement = await bridge.cancel(body.operationId);
        json(response, 200, { ok: true, acknowledgement });
        return;
      }
      if (!body.command || typeof body.command !== "string") {
        json(response, 400, { ok: false, error: "command is required" });
        return;
      }
      if (!body.requestId || !/^[a-f0-9-]{16,80}$/i.test(body.requestId)) {
        json(response, 400, { ok: false, error: "valid requestId is required" });
        return;
      }
      // The authenticated MCP client opts in per operation. The persistent
      // broker must not inherit the environment of whichever client started it.
      const operationId = validOperationId(body.operationId)
        ? body.operationId
        : body.requestId;
      const measure = body.telemetry === true && validOperationId(operationId);
      const now = Date.now();
      pruneRequests(now);
      let record = requests.get(operationId);
      const requestFingerprint = commandFingerprint(body.command, body.payload ?? {});
      if (body.fingerprint && body.fingerprint !== requestFingerprint) {
        json(response, 400, { ok: false, error: "operation fingerprint is invalid" });
        return;
      }
      if (record && record.fingerprint !== requestFingerprint) {
        json(response, 409, {
          ok: false,
          name: "OperationConflict",
          error: "operationId was already used for different command content",
          details: {
            outcome: "not_started",
            effectPossible: false,
            retrySafe: false
          }
        });
        return;
      }
      if (
        record?.settled
        && record.settledError instanceof OperationFailure
        && record.settledError.details.outcome === "effect_unknown"
      ) {
        const confirmed = bridge.confirmedResult(operationId, requestFingerprint);
        const replacement = confirmed && confirmed !== "conflict"
          ? confirmedPromise(confirmed)
          : null;
        if (replacement) {
          const previousBytes = Math.max(record.reservedBytes, record.actualBytes);
          record.promise = replacement;
          record.settledError = undefined;
          record.actualBytes = Buffer.byteLength(JSON.stringify(confirmed) || "null");
          record.createdAt = now;
          requestCacheBytes += Math.max(record.reservedBytes, record.actualBytes) - previousBytes;
          evictSettled(0);
          bridge.discardConfirmedResult(operationId, requestFingerprint);
        }
      }
      if (!record) {
        const confirmed = bridge.confirmedResult(operationId, requestFingerprint);
        if (confirmed === "conflict") {
          json(response, 409, {
            ok: false,
            name: "OperationConflict",
            error: "operationId has a confirmed result for different command content",
            details: {
              outcome: "not_started",
              effectPossible: false,
              retrySafe: false
            }
          });
          return;
        }
        if (confirmed) {
          const actualBytes = Buffer.byteLength(JSON.stringify(confirmed) || "null");
          evictSettled(actualBytes);
          if (
            requests.size < MAX_CACHED_REQUESTS
            && requestCacheBytes + actualBytes <= MAX_REQUEST_CACHE_BYTES
          ) {
            record = {
              createdAt: now,
              fingerprint: requestFingerprint,
              promise: confirmedPromise(confirmed)!,
              settled: true,
              reservedBytes: actualBytes,
              actualBytes,
              deadlineAt: Number(body.deadlineAt || now)
            };
            requests.set(operationId, record);
            requestCacheBytes += actualBytes;
            bridge.discardConfirmedResult(operationId, requestFingerprint);
            recovered = true;
          } else {
            if (confirmed.ok) {
              json(response, 200, {
                ok: true,
                result: confirmed.payload,
                outcome: "completed",
                operationId,
                recovered: true
              });
            } else {
              const failure = typeof confirmed.payload === "object" && confirmed.payload !== null
                ? confirmed.payload as { name?: unknown; message?: unknown; details?: unknown }
                : {};
              json(response, 422, {
                ok: false,
                name: typeof failure.name === "string" ? failure.name : "ExtensionCommandError",
                error: typeof failure.message === "string"
                  ? failure.message
                  : "Recovered extension command failed",
                details: failure.details,
                operationId,
                recovered: true
              });
            }
            return;
          }
        }
      }
      if (!record) {
        const deadlineAt = Number.isFinite(body.deadlineAt)
          ? Number(body.deadlineAt)
          : now + Math.min(Math.max(Number(body.timeoutMs || 60_000), 100), 600_000);
        if (remainingMs(deadlineAt, now) === 0) {
          json(response, 408, {
            ok: false,
            name: "NotStarted",
            error: "operation deadline expired before broker dispatch",
            details: {
              outcome: "not_started",
              effectPossible: false,
              retrySafe: true
            }
          });
          return;
        }
        const reservedBytes = reserveBytes(body.command, body.payload ?? {});
        evictSettled(reservedBytes);
        if (
          requests.size >= MAX_CACHED_REQUESTS
          || requestCacheBytes + reservedBytes > MAX_REQUEST_CACHE_BYTES
        ) {
          json(response, 507, {
            ok: false,
            name: "CapacityExceeded",
            error: "broker request cache byte capacity exceeded before dispatch",
            details: {
              outcome: "not_started",
              effectPossible: false,
              retrySafe: true,
              byteBudget: MAX_REQUEST_CACHE_BYTES
            }
          });
          return;
        }
        record = {
          createdAt: now,
          fingerprint: requestFingerprint,
          settled: false,
          promise: Promise.resolve(),
          reservedBytes,
          actualBytes: 0,
          deadlineAt
        };
        requestCacheBytes += reservedBytes;
        if (measure) {
          record.telemetry = newTelemetry(body.command, operationId);
          record.telemetry.brokerActiveRequests = clients;
          const queue = bridge.queueStatus();
          // Commands already active or waiting are ahead of this operation.
          record.telemetry.brokerQueueDepth = queue.active + queue.queued;
          record.telemetry.schedulerActiveCount = queue.active;
          record.telemetry.schedulerConfiguredMax = queue.configuredMax;
        }
        const startedAt = performance.now();
        const current = record;
        const operation: OperationDescriptor = {
          operationId,
          fingerprint: requestFingerprint,
          deadlineAt
        };
        record.promise = bridge.send(
            body.command,
            body.payload ?? {},
            operation,
            record.telemetry
          ).then((result) => {
            current.actualBytes = Buffer.byteLength(JSON.stringify(result) || "null");
            return result;
          }).catch((error) => {
            current.settledError = error;
            throw error;
          }).finally(() => {
            current.settled = true;
            const previous = current.reservedBytes;
            const next = Math.max(current.reservedBytes, current.actualBytes);
            requestCacheBytes += next - previous;
            if (current.telemetry) {
              const queue = bridge.queueStatus();
              current.telemetry.brokerTotalMs = performance.now() - startedAt;
              current.telemetry.brokerRssBytes = process.memoryUsage().rss;
              current.telemetry.schedulerMaxObservedActive = queue.maxObservedActive;
            }
            evictSettled(0);
          });
        requests.set(operationId, record);
      }
      metrics = measure && record.telemetry?.operationId === operationId ? record.telemetry : undefined;
      const result = await record.promise;
      json(response, 200, {
        ok: true,
        result,
        outcome: "completed",
        operationId,
        ...(recovered ? { recovered: true } : {}),
        ...(metrics ? { telemetry: sanitizeTelemetry(metrics) } : {})
      });
    } catch (error) {
      if (error instanceof OperationFailure) {
        const status = error.details.outcome === "effect_unknown" ? 502 : 409;
        json(response, status, {
          ok: false,
          error: error.message,
          name: error.name,
          details: error.details,
          ...(recovered ? { recovered: true } : {}),
          ...(metrics ? { telemetry: sanitizeTelemetry(metrics) } : {})
        });
        return;
      }
      if (error instanceof ExtensionCommandError) {
        json(response, 422, {
          ok: false,
          error: error.message,
          name: error.name,
          details: error.details,
          ...(recovered ? { recovered: true } : {}),
          ...(metrics ? { telemetry: sanitizeTelemetry(metrics) } : {})
        });
        return;
      }
      json(response, 502, {
        ok: false,
        error: error instanceof Error ? error.message : "broker command failed",
        ...(metrics ? { telemetry: sanitizeTelemetry(metrics) } : {})
      });
    } finally {
      clients = Math.max(0, clients - 1);
    }
  });
});

await bridge.start();
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(IPC_PORT, HOST, () => resolve());
});
const address = server.address() as AddressInfo;
const runtime = await writeRuntime(address.port, instanceId);
token = runtime.token;

async function shutdown(): Promise<void> {
  await bridge.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
