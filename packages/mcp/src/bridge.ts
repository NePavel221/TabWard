import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import {
  type AddressInfo
} from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  cancelledBeforeEffect,
  commandFingerprint,
  notStarted,
  outcomeUnknown,
  webSocketSendFailure,
  remainingMs,
  type OperationDescriptor
} from "./operation.js";
import { createPairingToken, readPairingToken } from "./state.js";
import { sanitizeTelemetry, type OperationTelemetry } from "./telemetry.js";

const PROTOCOL_VERSION = 2;
const DEFAULT_WS_PORT = 18766;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

interface CommandEnvelope {
  kind: "command";
  id: string;
  protocolVersion: number;
  type: string;
  payload: Record<string, unknown>;
  operationId: string;
  fingerprint: string;
  deadlineAt: number;
  telemetry?: boolean;
}

export interface ResultEnvelope {
  kind: "result";
  id: string;
  protocolVersion: number;
  ok: boolean;
  payload: unknown;
  operationId: string;
  fingerprint?: string;
  telemetry?: unknown;
}

interface CancelAckEnvelope {
  kind: "cancel_ack";
  protocolVersion: number;
  operationId: string;
  state: "not_found" | "queued" | "active" | "completed";
}

interface HelloEnvelope {
  kind: "hello";
  protocolVersion: number;
  extensionId: string;
  extensionVersion: string;
  token?: string;
}

function isLocalExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === "string"
    && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  telemetry?: OperationTelemetry;
  sentAt: number;
  operationId: string;
  fingerprint: string;
  dispatched: boolean;
}

interface QueuedCommand {
  cancelled: boolean;
  active: boolean;
}

interface BridgeStatus {
  state: "not_running" | "pairing_required" | "connected" | "version_mismatch";
  extensionId: string | null;
  extensionVersion: string | null;
  pairingCode: string | null;
  connectedAt: string | null;
}

export class ExtensionCommandError extends Error {
  constructor(
    message: string,
    readonly extensionName = "ExtensionCommandError",
    readonly details: unknown = null
  ) {
    super(message);
    this.name = extensionName;
  }
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ExtensionBridge extends EventEmitter {
  readonly host = "127.0.0.1";
  #port: number;
  #http: HttpServer | null = null;
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #pairingToken: string | null = null;
  #pairingCode: string | null = null;
  #pairingExpiresAt = 0;
  #pairingAttempts = 0;
  #extensionId: string | null = null;
  #extensionVersion: string | null = null;
  #connectedAt: string | null = null;
  #state: BridgeStatus["state"] = "not_running";
  #pending = new Map<string, PendingCommand>();
  #queuedOperations = new Map<string, QueuedCommand>();
  #cancelAcks = new Map<string, (ack: CancelAckEnvelope) => void>();
  #confirmed = new Map<string, {
    fingerprint: string;
    result: ResultEnvelope;
    bytes: number;
    createdAt: number;
  }>();
  #confirmedBytes = 0;
  readonly #maxConfirmedBytes = Math.max(
    4 * 1024 * 1024,
    Number(process.env.TABWARD_CONFIRMED_CACHE_BYTES || 32 * 1024 * 1024)
  );
  readonly #maxConfirmedResults = 128;
  #commandTail: Promise<void> = Promise.resolve();
  #queued = 0;
  #active = 0;

  constructor(port = Number(process.env.TABWARD_PORT || DEFAULT_WS_PORT)) {
    super();
    this.#port = port;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    if (this.#server) {
      return;
    }
    this.#pairingToken = await readPairingToken();
    this.#http = createServer((request, response) => {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json"
      });
      response.end('{"ok":false,"error":"not found"}');
    });
    this.#server = new WebSocketServer({
      server: this.#http,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: ({ origin }: { origin: string }) =>
        isLocalExtensionOrigin(origin)
    });
    this.#server.on("connection", (socket, request) => {
      this.#accept(socket, request.headers.origin);
    });
    await new Promise<void>((resolve, reject) => {
      this.#http?.once("error", reject);
      this.#http?.listen(this.port, this.host, () => {
        this.#http?.removeListener("error", reject);
        const address = this.#http?.address() as AddressInfo | null;
        if (address) {
          this.#port = address.port;
        }
        resolve();
      });
    });
  }

  status(): BridgeStatus {
    return {
      state: this.#state,
      extensionId: this.#extensionId,
      extensionVersion: this.#extensionVersion,
      pairingCode: this.#state === "pairing_required" ? this.#pairingCode : null,
      connectedAt: this.#connectedAt
    };
  }

  queueStatus(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#queued };
  }

  confirmedResult(
    operationId: string,
    fingerprint: string
  ): ResultEnvelope | null | "conflict" {
    const record = this.#confirmed.get(operationId);
    if (!record) return null;
    return record.fingerprint === fingerprint ? record.result : "conflict";
  }

  discardConfirmedResult(operationId: string, fingerprint: string): void {
    this.#removeConfirmed(operationId, fingerprint);
  }

  async send(
    type: string,
    payload: Record<string, unknown> = {},
    operation?: OperationDescriptor,
    telemetry?: OperationTelemetry
  ): Promise<unknown> {
    operation ??= {
      operationId: randomUUID(),
      fingerprint: commandFingerprint(type, payload),
      deadlineAt: Date.now() + COMMAND_TIMEOUT_MS
    };
    if (this.#queuedOperations.has(operation.operationId)
      || [...this.#pending.values()].some((entry) => entry.operationId === operation.operationId)) {
      throw new Error(`Operation ${operation.operationId} is already queued`);
    }
    const queuedAt = performance.now();
    const queued = { cancelled: false, active: false };
    this.#queuedOperations.set(operation.operationId, queued);
    this.#queued += 1;
    const previous = this.#commandTail;
    let release!: () => void;
    this.#commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    this.#queued -= 1;
    this.#active += 1;
    queued.active = true;
    if (telemetry) telemetry.bridgeQueueWaitMs = performance.now() - queuedAt;
    try {
      if (queued.cancelled) {
        throw cancelledBeforeEffect("cancelled while waiting in the broker queue");
      }
      if (remainingMs(operation.deadlineAt) === 0) {
        throw notStarted("deadline expired while waiting in the broker queue");
      }
      return await this.#sendNow(type, payload, operation, telemetry);
    } finally {
      this.#queuedOperations.delete(operation.operationId);
      this.#active -= 1;
      release();
    }
  }

  async #sendNow(
    type: string,
    payload: Record<string, unknown>,
    operation: OperationDescriptor,
    telemetry?: OperationTelemetry
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#state !== "connected") {
      throw notStarted(
        this.#state === "pairing_required"
          ? "TabWard extension pairing is required"
          : "TabWard extension is not connected"
      );
    }
    const id = operation.operationId;
    const message: CommandEnvelope = {
      kind: "command",
      id,
      protocolVersion: PROTOCOL_VERSION,
      type,
      payload,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      deadlineAt: operation.deadlineAt,
      ...(telemetry ? { telemetry: true } : {})
    };
    return await new Promise((resolve, reject) => {
      const timeoutMs = remainingMs(operation.deadlineAt);
      if (timeoutMs === 0) {
        reject(notStarted("deadline expired before WebSocket dispatch"));
        return;
      }
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(outcomeUnknown(`deadline expired after ${type} was dispatched`));
      }, timeoutMs);
      const pending: PendingCommand = {
        resolve,
        reject,
        timeout,
        telemetry,
        sentAt: performance.now(),
        operationId: operation.operationId,
        fingerprint: operation.fingerprint,
        dispatched: false
      };
      this.#pending.set(id, pending);
      socket.send(JSON.stringify(message), (error) => {
        if (!error) {
          pending.dispatched = true;
          return;
        }
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(webSocketSendFailure(error.message));
      });
    });
  }

  async cancel(operationId: string, timeoutMs = 2_000): Promise<CancelAckEnvelope> {
    const queued = this.#queuedOperations.get(operationId);
    if (queued && !queued.active) {
      queued.cancelled = true;
      return {
        kind: "cancel_ack",
        protocolVersion: PROTOCOL_VERSION,
        operationId,
        state: "queued"
      };
    }
    const pending = this.#pending.get(operationId);
    const socket = this.#socket;
    if (!pending || !socket || socket.readyState !== WebSocket.OPEN) {
      return {
        kind: "cancel_ack",
        protocolVersion: PROTOCOL_VERSION,
        operationId,
        state: "not_found"
      };
    }
    const ack = await new Promise<CancelAckEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        this.#cancelAcks.delete(operationId);
        resolve({
          kind: "cancel_ack",
          protocolVersion: PROTOCOL_VERSION,
          operationId,
          state: "active"
        });
      }, timeoutMs);
      this.#cancelAcks.set(operationId, (value) => {
        clearTimeout(timer);
        this.#cancelAcks.delete(operationId);
        resolve(value);
      });
      socket.send(JSON.stringify({
        kind: "cancel",
        protocolVersion: PROTOCOL_VERSION,
        operationId
      }));
    });
    return ack;
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(pending.dispatched
        ? outcomeUnknown("bridge stopped after WebSocket dispatch")
        : notStarted("bridge stopped before WebSocket dispatch"));
    }
    this.#pending.clear();
    this.#queuedOperations.clear();
    this.#cancelAcks.clear();
    this.#socket?.terminate();
    for (const client of this.#server?.clients ?? []) {
      client.terminate();
    }
    if (this.#server) {
      await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    }
    if (this.#http) {
      await new Promise<void>((resolve) => this.#http?.close(() => resolve()));
    }
    this.#server = null;
    this.#http = null;
    this.#state = "not_running";
  }

  #accept(socket: WebSocket, origin: string | undefined): void {
    const extensionId = origin?.slice("chrome-extension://".length) ?? null;
    let authenticated = false;
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!authenticated) {
          authenticated = await this.#authenticate(socket, message, extensionId);
          return;
        }
        if (message.kind === "ping") {
          socket.send(JSON.stringify({ kind: "pong", protocolVersion: PROTOCOL_VERSION }));
          return;
        }
        if (message.kind === "result") {
          const received = this.#receiveResult(message as unknown as ResultEnvelope);
          socket.send(JSON.stringify(received.cached ? {
            kind: "result_ack",
            id: message.id,
            fingerprint: received.fingerprint,
            protocolVersion: PROTOCOL_VERSION
          } : {
            kind: "result_backpressure",
            id: message.id,
            fingerprint: received.fingerprint,
            protocolVersion: PROTOCOL_VERSION,
            retryAfterMs: 1_000
          }), (error) => {
            if (!error && received.cached && received.pending) {
              this.#removeConfirmed(received.operationId, received.fingerprint);
            }
          });
          return;
        }
        if (message.kind === "cancel_ack") {
          const ack = message as unknown as CancelAckEnvelope;
          this.#cancelAcks.get(ack.operationId)?.(ack);
        }
      } catch {
        socket.close(1008, "invalid protocol message");
      }
    });
    socket.on("close", () => {
      if (this.#socket === socket) {
        for (const [id, pending] of this.#pending) {
          clearTimeout(pending.timeout);
          pending.reject(pending.dispatched
            ? outcomeUnknown("extension disconnected after WebSocket dispatch")
            : notStarted("extension disconnected before WebSocket dispatch"));
          this.#pending.delete(id);
        }
        this.#socket = null;
        this.#connectedAt = null;
        this.#state = this.#pairingToken ? "not_running" : "pairing_required";
      }
    });
  }

  async #authenticate(
    socket: WebSocket,
    message: Record<string, unknown>,
    extensionId: string | null
  ): Promise<boolean> {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.#state = "version_mismatch";
      socket.send(JSON.stringify({
        kind: "version_mismatch",
        protocolVersion: PROTOCOL_VERSION
      }));
      socket.close(1008, "protocol version mismatch");
      return false;
    }
    if (
      message.kind === "pairing_approve"
      && Date.now() <= this.#pairingExpiresAt
      && this.#pairingAttempts < 5
      && message.code === this.#pairingCode
    ) {
      this.#pairingToken = await createPairingToken();
      this.#pairingCode = null;
      this.#pairingExpiresAt = 0;
      this.#pairingAttempts = 0;
      socket.send(JSON.stringify({
        kind: "pairing_approved",
        protocolVersion: PROTOCOL_VERSION,
        token: this.#pairingToken
      }));
      return false;
    }
    if (message.kind === "pairing_approve") {
      this.#pairingAttempts += 1;
      if (this.#pairingAttempts >= 5) {
        this.#pairingCode = null;
        this.#pairingExpiresAt = 0;
        socket.close(1008, "too many pairing attempts");
      }
      return false;
    }
    if (message.kind !== "hello") {
      throw new Error("hello required");
    }
    const hello = message as unknown as HelloEnvelope;
    if (hello.extensionId !== extensionId) {
      socket.close(1008, "extension identity mismatch");
      return false;
    }
    this.#extensionId = extensionId;
    this.#extensionVersion = hello.extensionVersion;
    if (
      this.#pairingToken
      && typeof hello.token === "string"
      && tokensEqual(hello.token, this.#pairingToken)
    ) {
      this.#socket?.close(1000, "replaced by new extension connection");
      this.#socket = socket;
      this.#connectedAt = new Date().toISOString();
      this.#state = "connected";
      socket.send(JSON.stringify({
        kind: "ready",
        protocolVersion: PROTOCOL_VERSION
      }));
      this.emit("connected", this.status());
      return true;
    }
    if (!this.#pairingCode || Date.now() > this.#pairingExpiresAt) {
      this.#pairingCode = String(
        Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000
      ).padStart(6, "0");
      this.#pairingExpiresAt = Date.now() + 5 * 60_000;
      this.#pairingAttempts = 0;
    }
    this.#state = "pairing_required";
    socket.send(JSON.stringify({
      kind: "pairing_required",
      protocolVersion: PROTOCOL_VERSION
    }));
    this.emit("pairing", this.status());
    return false;
  }

  #cacheConfirmed(result: ResultEnvelope): boolean {
    if (!result.operationId || !result.fingerprint) return false;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const previous = this.#confirmed.get(result.operationId);
    if (previous && previous.fingerprint !== result.fingerprint) return false;
    const previousBytes = previous?.bytes ?? 0;
    if (
      bytes > this.#maxConfirmedBytes
      || this.#confirmed.size + (previous ? 0 : 1) > this.#maxConfirmedResults
      || this.#confirmedBytes - previousBytes + bytes > this.#maxConfirmedBytes
    ) {
      return false;
    }
    if (previous) this.#confirmedBytes -= previous.bytes;
    this.#confirmed.set(result.operationId, {
      fingerprint: result.fingerprint,
      result,
      bytes,
      createdAt: Date.now()
    });
    this.#confirmedBytes += bytes;
    return true;
  }

  #removeConfirmed(operationId: string, fingerprint: string): void {
    const record = this.#confirmed.get(operationId);
    if (!record || record.fingerprint !== fingerprint) return;
    this.#confirmed.delete(operationId);
    this.#confirmedBytes = Math.max(0, this.#confirmedBytes - record.bytes);
  }

  #receiveResult(result: ResultEnvelope): {
    cached: boolean;
    pending: boolean;
    operationId: string;
    fingerprint: string;
  } {
    const pending = this.#pending.get(result.id);
    const normalized = pending && !result.fingerprint
      ? {
        ...result,
        operationId: result.operationId || pending.operationId,
        fingerprint: pending.fingerprint
      }
      : result;
    const operationId = normalized.operationId || normalized.id;
    const fingerprint = normalized.fingerprint || "";
    if (pending && pending.fingerprint !== normalized.fingerprint) {
      return {
        cached: false,
        pending: true,
        operationId: pending.operationId,
        fingerprint: pending.fingerprint
      };
    }
    const cached = this.#cacheConfirmed(normalized);
    if (!pending) {
      return {
        cached,
        pending: false,
        operationId,
        fingerprint
      };
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(result.id);
    if (pending.telemetry) {
      const metrics = pending.telemetry;
      metrics.bridgeRoundTripMs = performance.now() - pending.sentAt;
      metrics.resultBytes = Buffer.byteLength(JSON.stringify(normalized.payload) ?? "null");
      const extension = normalized.operationId === metrics.operationId
        ? sanitizeTelemetry({
          ...(typeof normalized.telemetry === "object" ? normalized.telemetry : {}),
          operationId: normalized.operationId,
          operationType: metrics.operationType
        })
        : undefined;
      // Only extension-owned durations; do not trust echoed broker/client fields.
      if (extension?.extensionExecutionMs !== undefined) {
        metrics.extensionExecutionMs = extension.extensionExecutionMs;
      }
      if (extension?.outboxCommitMs !== undefined) metrics.outboxCommitMs = extension.outboxCommitMs;
      if (metrics.extensionExecutionMs !== undefined && metrics.outboxCommitMs !== undefined) {
        metrics.transferResidualMs = Math.max(0,
          metrics.bridgeRoundTripMs - metrics.extensionExecutionMs - metrics.outboxCommitMs);
      }
    }
    if (normalized.ok) {
      pending.resolve(normalized.payload);
      return {
        cached,
        pending: true,
        operationId,
        fingerprint
      };
    }
    if (
      typeof normalized.payload === "object"
      && normalized.payload !== null
      && "ok" in normalized.payload
    ) {
      pending.resolve(normalized.payload);
      return {
        cached,
        pending: true,
        operationId,
        fingerprint
      };
    }
    const payload = typeof normalized.payload === "object" && normalized.payload !== null
      ? normalized.payload as { name?: unknown; message?: unknown; details?: unknown }
      : null;
    const message = payload && "message" in payload
      ? String(payload.message)
      : "TabWard extension command failed";
    pending.reject(new ExtensionCommandError(
      message,
      typeof payload?.name === "string" ? payload.name : "ExtensionCommandError",
      payload && "details" in payload ? payload.details : normalized.payload
    ));
    return {
      cached,
      pending: true,
      operationId,
      fingerprint
    };
  }
}
