#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, isAbsolute } from "node:path";
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
const MAX_PAYLOAD_DEPTH = 24;
const MAX_PAYLOAD_KEYS = 20_000;
const MAX_PAYLOAD_STRING = 16 * 1024 * 1024;
const MANAGED_SESSION_CAPABILITIES = new Set([
  "read", "action", "artifacts", "downloads", "emulation",
  "evaluate_local", "events", "probes", "tracing", "uploads"
]);
const FULL_PROFILE_SESSION_CAPABILITIES = new Set([
  ...MANAGED_SESSION_CAPABILITIES,
  "adopt_tabs", "cdp", "evaluate", "network_interception", "storage"
]);
const COMMAND_CAPABILITY_POLICY: Readonly<
  Record<string, readonly string[] | null>
> = Object.freeze({
  ping: null,
  getUserSettings: null,
  reloadExtension: null,
  nameSession: [],
  cleanup: [],
  releaseWorkspace: [],
  turnEnded: [],
  openTab: ["action"],
  tabs: ["read"],
  navigate: ["action"],
  navigateAdvanced: ["action"],
  goBack: ["action"],
  goForward: ["action"],
  getText: ["read"],
  getHtml: ["read"],
  getPageState: ["read"],
  extractTables: ["read"],
  observe: ["read"],
  snapshot: ["read"],
  query: ["read"],
  queryRich: ["read"],
  extractImages: ["read"],
  resolveTarget: ["read"],
  click: ["action"],
  fill: ["action"],
  smartClick: ["action"],
  smartFill: ["action"],
  locatorAction: ["action"],
  form: ["action"],
  locatorWait: ["read"],
  locatorAssert: ["read"],
  workflow: ["action"],
  downloadClick: ["downloads"],
  downloadImage: ["downloads"],
  downloads: ["downloads"],
  deleteDownload: ["downloads"],
  closeTab: ["action"],
  activateTab: ["action"],
  cursor: ["action"],
  finish: ["action"],
  reload: ["action"],
  waitForText: ["read"],
  waitForSelector: ["read"],
  attach: ["cdp"],
  detach: ["cdp"],
  cdp: ["cdp"],
  eventsStart: ["events"],
  eventsPoll: ["events"],
  eventsClear: ["events"],
  eventsStop: ["events"],
  dialogHandle: ["events"],
  networkBody: ["events"],
  networkHar: ["events"],
  interceptionStart: ["network_interception"],
  interceptionContinue: ["network_interception"],
  interceptionFail: ["network_interception"],
  interceptionFulfill: ["network_interception"],
  interceptionStop: ["network_interception"],
  emulation: ["emulation"],
  storage: ["storage"],
  traceStart: ["tracing"],
  traceStop: ["tracing"],
  screencastStart: ["tracing"],
  screencastFrame: ["tracing"],
  screencastStop: ["tracing"],
  screenshot: ["artifacts"],
  evaluate: [],
  probe: ["probes"],
  qa: ["probes"],
  inputMouse: ["action"],
  inputKey: ["action"],
  inputScroll: ["action"],
  handoff: ["action"],
  deliverable: ["action"],
  adoptTab: ["adopt_tabs"],
  releaseTab: ["action"]
});
const COMMAND_ALLOWLIST = new Set(Object.keys(COMMAND_CAPABILITY_POLICY));
const WORKFLOW_STEP_CAPABILITY_POLICY: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    observe: ["read"],
    smartClick: ["action"],
    smartFill: ["action"],
    navigate: ["action"],
    pageState: ["read"],
    queryRich: ["read"],
    extractImages: ["read"],
    waitForText: ["read"],
    waitForSelector: ["read"],
    reload: ["action"],
    inputKey: ["action"],
    inputScroll: ["action"]
  });
const FORM_FIELD_CAPABILITY_POLICY: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    click: ["action"],
    doubleClick: ["action"],
    hover: ["action"],
    fill: ["action"],
    type: ["action"],
    press: ["action"],
    check: ["action"],
    uncheck: ["action"],
    select: ["action"],
    focus: ["action"],
    blur: ["action"],
    drag: ["action"],
    upload: ["uploads"]
  });
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

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePayloadShape(
  value: unknown,
  depth = 0,
  budget = { keys: 0 }
): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new Error("command payload nesting is too deep");
  }
  if (typeof value === "string" && value.length > MAX_PAYLOAD_STRING) {
    throw new Error("command payload string is too large");
  }
  if (Array.isArray(value)) {
    budget.keys += value.length;
    if (budget.keys > MAX_PAYLOAD_KEYS) {
      throw new Error("command payload has too many entries");
    }
    for (const item of value) validatePayloadShape(item, depth + 1, budget);
    return;
  }
  if (value && typeof value === "object") {
    if (!plainObject(value)) {
      throw new Error("command payload contains an unsupported object");
    }
    const entries = Object.entries(value);
    budget.keys += entries.length;
    if (budget.keys > MAX_PAYLOAD_KEYS) {
      throw new Error("command payload has too many entries");
    }
    for (const [, item] of entries) {
      validatePayloadShape(item, depth + 1, budget);
    }
  }
}

function validSessionPayload(payload: Record<string, unknown>): boolean {
  const capabilities = Array.isArray(payload.sessionCapabilities)
    ? payload.sessionCapabilities
    : [];
  const uniqueCapabilities = new Set(capabilities);
  const mode = String(payload.sessionMode);
  const allowedCapabilities = mode === "managed"
    ? MANAGED_SESSION_CAPABILITIES
    : FULL_PROFILE_SESSION_CAPABILITIES;
  return typeof payload.sessionId === "string"
    && payload.sessionId.length >= 1
    && payload.sessionId.length <= 80
    && /^[A-Za-z0-9_-]+$/.test(payload.sessionId)
    && typeof payload.sessionName === "string"
    && payload.sessionName.length >= 1
    && payload.sessionName.length <= 80
    && ["managed", "full_profile"].includes(mode)
    && Array.isArray(payload.sessionCapabilities)
    && uniqueCapabilities.size === capabilities.length
    && capabilities.every((capability) =>
      typeof capability === "string"
      && capability.length <= 64
      && allowedCapabilities.has(capability))
    && typeof payload.canAdoptExistingTabs === "boolean"
    && payload.canAdoptExistingTabs === capabilities.includes("adopt_tabs")
    && typeof payload.cleanQa === "boolean"
    && Number.isFinite(payload.sessionExpiresAt)
    && Number(payload.sessionExpiresAt) > Date.now() / 1000;
}

function commandCapabilities(
  command: string,
  payload: Record<string, unknown>
): string[] {
  const capabilities = [...(COMMAND_CAPABILITY_POLICY[command] || [])];
  if (command === "locatorAction" && payload.action === "upload") {
    return ["uploads"];
  }
  if (command === "evaluate") {
    return [payload.sessionMode === "managed" ? "evaluate_local" : "evaluate"];
  }
  if (command === "qa") {
    if (payload.preset || payload.viewport) capabilities.push("emulation");
    if (payload.captureConsole === true || payload.captureNetwork === true) {
      capabilities.push("events");
    }
    if (Array.isArray(payload.screenshots) && payload.screenshots.length > 0) {
      capabilities.push("artifacts");
    }
  }
  if (command === "workflow") {
    if (!Array.isArray(payload.steps)) {
      throw new Error("workflow steps must be an array");
    }
    for (const [index, step] of payload.steps.entries()) {
      if (!plainObject(step) || typeof step.type !== "string") {
        throw new Error(`workflow step ${index} is invalid`);
      }
      const required = WORKFLOW_STEP_CAPABILITY_POLICY[step.type];
      if (!required) {
        throw new Error(`workflow step type is not allowed: ${step.type || "<empty>"}`);
      }
      capabilities.push(...required);
    }
  }
  if (command === "form") {
    if (!Array.isArray(payload.fields)) {
      throw new Error("form fields must be an array");
    }
    for (const [index, field] of payload.fields.entries()) {
      if (!plainObject(field) || typeof field.action !== "string") {
        throw new Error(`form field ${index} is invalid`);
      }
      const required = FORM_FIELD_CAPABILITY_POLICY[field.action];
      if (!required) {
        throw new Error(`form field action is not allowed: ${field.action || "<empty>"}`);
      }
      capabilities.push(...required);
    }
  }
  return [...new Set(capabilities)];
}

function localAbsolutePath(value: string): boolean {
  if (/^(?:\\\\|\/\/|\\\\[?.]\\|\\\?\?\\)/.test(value)) return false;
  if (process.platform === "win32") {
    return /^[a-zA-Z]:[\\/](?![\\/])/.test(value);
  }
  return isAbsolute(value)
    && !value.startsWith("//")
    && !value.startsWith("/dev/");
}

async function validateUploadPayload(payload: Record<string, unknown>): Promise<void> {
  if (payload.action !== "upload") return;
  const paths = Array.isArray(payload.value)
    ? payload.value
    : [payload.value];
  if (
    paths.length < 1
    || paths.length > 100
    || paths.some((value) => typeof value !== "string" || !localAbsolutePath(value))
  ) {
    throw new Error("upload requires readable absolute local file paths");
  }
  for (const value of paths as string[]) {
    const metadata = await stat(value).catch(() => null);
    if (!metadata?.isFile()) {
      throw new Error(
        `upload file is missing or unreadable: ${basename(value) || "[unnamed file]"}`
      );
    }
  }
}

async function validateCommandRequest(
  command: unknown,
  payload: unknown
): Promise<Record<string, unknown>> {
  if (typeof command !== "string" || !COMMAND_ALLOWLIST.has(command)) {
    throw new Error("command is not allowed");
  }
  if (!plainObject(payload)) {
    throw new Error("command payload must be a plain object");
  }
  validatePayloadShape(payload);
  const capabilityPolicy = COMMAND_CAPABILITY_POLICY[command];
  const sessionFields = [
    "sessionId", "sessionName", "sessionMode", "sessionCapabilities",
    "canAdoptExistingTabs", "cleanQa", "sessionExpiresAt"
  ];
  const hasSessionContext = sessionFields.some((field) =>
    Object.prototype.hasOwnProperty.call(payload, field));
  if (
    (capabilityPolicy !== null || hasSessionContext)
    && !validSessionPayload(payload)
  ) {
    throw new Error("command session context is invalid or expired");
  }
  if (capabilityPolicy !== null) {
    const capabilities = payload.sessionCapabilities as unknown[];
    for (const requiredCapability of commandCapabilities(command, payload)) {
      if (!capabilities.includes(requiredCapability)) {
        throw new Error(`${command} requires the ${requiredCapability} capability`);
      }
    }
  }
  if (command === "evaluate") {
    const capabilities = Array.isArray(payload.sessionCapabilities)
      ? payload.sessionCapabilities
      : [];
    const managed = payload.sessionMode === "managed";
    if (
      !validSessionPayload(payload)
      || (managed && (
        payload.localOnly !== true
        || payload.privileged === true
        || !capabilities.includes("evaluate_local")
      ))
      || (!managed && (
        payload.privileged !== true
        || !capabilities.includes("evaluate")
      ))
    ) {
      throw new Error("evaluate capability context is invalid");
    }
  }
  await validateUploadPayload(payload);
  return payload;
}

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
      brokerVersion: "0.4.0",
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
      if (!body.requestId || !/^[a-f0-9-]{16,80}$/i.test(body.requestId)) {
        json(response, 400, { ok: false, error: "valid requestId is required" });
        return;
      }
      let validatedPayload: Record<string, unknown>;
      try {
        validatedPayload = await validateCommandRequest(
          body.command,
          body.payload ?? {}
        );
      } catch (error) {
        json(response, 400, {
          ok: false,
          error: error instanceof Error
            ? error.message
            : "command validation failed"
        });
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
      const requestFingerprint = commandFingerprint(body.command!, validatedPayload);
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
        if (
          body.deadlineAt !== undefined
          && (
            !Number.isFinite(body.deadlineAt)
            || Number(body.deadlineAt) > now + 600_000
          )
        ) {
          json(response, 400, { ok: false, error: "operation deadline is invalid" });
          return;
        }
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
        const reservedBytes = reserveBytes(body.command!, validatedPayload);
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
          record.telemetry = newTelemetry(body.command!, operationId);
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
            body.command!,
            validatedPayload,
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
