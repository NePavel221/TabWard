#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ExtensionBridge, ExtensionCommandError } from "./bridge.js";
import { writeRuntime } from "./runtime.js";

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
}>();
const REQUEST_TTL_MS = 60 * 60_000;
const MAX_CACHED_REQUESTS = 256;

function authorized(value: string | undefined): boolean {
  if (!value || !token) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fingerprint(command: string, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify({ command, payload }))
    .digest("hex");
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
  if (request.method !== "POST" || request.url !== "/command") {
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
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        requestId?: string;
        command?: string;
        payload?: Record<string, unknown>;
        timeoutMs?: number;
      };
      if (!body.command || typeof body.command !== "string") {
        json(response, 400, { ok: false, error: "command is required" });
        return;
      }
      if (!body.requestId || !/^[a-f0-9-]{16,80}$/i.test(body.requestId)) {
        json(response, 400, { ok: false, error: "valid requestId is required" });
        return;
      }
      const now = Date.now();
      for (const [id, record] of requests) {
        if (now - record.createdAt > REQUEST_TTL_MS) requests.delete(id);
      }
      let record = requests.get(body.requestId);
      const requestFingerprint = fingerprint(body.command, body.payload ?? {});
      if (record && record.fingerprint !== requestFingerprint) {
        json(response, 409, {
          ok: false,
          error: "requestId was already used for different command content"
        });
        return;
      }
      if (!record) {
        while (requests.size >= MAX_CACHED_REQUESTS) {
          const removable = [...requests.entries()]
            .filter(([, candidate]) => candidate.settled)
            .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
          if (!removable) {
            json(response, 503, {
              ok: false,
              error: "broker request cache capacity exceeded"
            });
            return;
          }
          requests.delete(removable[0]);
        }
        record = {
          createdAt: now,
          fingerprint: requestFingerprint,
          settled: false,
          promise: Promise.resolve()
        };
        record.promise = bridge.send(
            body.command,
            body.payload ?? {},
            Math.min(Math.max(Number(body.timeoutMs || 60_000), 100), 600_000)
          ).finally(() => {
            if (record) record.settled = true;
          });
        requests.set(body.requestId, record);
      }
      const result = await record.promise;
      json(response, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof ExtensionCommandError) {
        json(response, 422, {
          ok: false,
          error: error.message,
          name: error.name,
          details: error.details
        });
        return;
      }
      json(response, 502, {
        ok: false,
        error: error instanceof Error ? error.message : "broker command failed"
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
