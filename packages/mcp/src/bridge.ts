import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
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
import {
  classifyCommand,
  FairScheduler,
  schedulerOptionsFromEnv
} from "./scheduler.js";

const PROTOCOL_VERSION = 3;
const DEFAULT_WS_PORT = 18766;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_PREAUTH_MESSAGE_BYTES = 64 * 1024;
const MAX_PREAUTH_CONNECTIONS = 8;
const MAX_PREAUTH_MESSAGES = 6;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 30_000;
const PAIRING_KDF_ITERATIONS = 150_000;
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
  clientNonce: string;
  hasPairingToken?: boolean;
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function handshakeTranscript(fields: {
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
  extensionNonce: string;
  extensionId: string;
  protocolVersion: number;
}): string {
  return stableStringify({
    connectionId: fields.connectionId,
    clientNonce: fields.clientNonce,
    serverNonce: fields.serverNonce,
    extensionNonce: fields.extensionNonce,
    extensionId: fields.extensionId,
    protocolVersion: fields.protocolVersion
  });
}

function hmacSha256(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function derivePairingKey(code: string, transcript: string): string {
  const salt = createHash("sha256")
    .update(`tabward-pairing:${transcript}`)
    .digest();
  return pbkdf2Sync(
    code,
    salt,
    PAIRING_KDF_ITERATIONS,
    32,
    "sha256"
  ).toString("base64url");
}

function nonce(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface HandshakeState {
  phase:
    | "hello"
    | "auth_challenge"
    | "auth_proof"
    | "pairing_required"
    | "pairing_proof";
  connectionId: string;
  clientNonce: string;
  serverNonce: string;
  extensionNonce: string;
  extensionId: string;
  extensionVersion: string;
  messages: number;
}

export interface ExtensionBridgeOptions {
  pairingLockoutMs?: number;
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
  #pairingLockedUntil = 0;
  #preauthSockets = new Set<WebSocket>();
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
  readonly #scheduler = new FairScheduler(schedulerOptionsFromEnv());
  readonly #pairingLockoutMs: number;

  constructor(
    port = Number(process.env.TABWARD_PORT || DEFAULT_WS_PORT),
    options: ExtensionBridgeOptions = {}
  ) {
    super();
    this.#port = port;
    this.#pairingLockoutMs = Math.max(
      1_000,
      Math.min(5 * 60_000, Number(options.pairingLockoutMs || PAIRING_LOCKOUT_MS))
    );
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
      pairingCode: this.#state === "pairing_required"
        && Date.now() >= this.#pairingLockedUntil
        ? this.#pairingCode
        : null,
      connectedAt: this.#connectedAt
    };
  }

  queueStatus(): {
    active: number;
    queued: number;
    configuredMax: number;
    maxObservedActive: number;
  } {
    return this.#scheduler.metrics();
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
    const queued = { cancelled: false, active: false };
    this.#queuedOperations.set(operation.operationId, queued);
    try {
      return await this.#scheduler.schedule(
        operation,
        classifyCommand(type, payload),
        async () => {
          queued.active = true;
          if (queued.cancelled) {
            throw cancelledBeforeEffect("cancelled before WebSocket dispatch");
          }
          return await this.#sendNow(type, payload, operation, telemetry);
        },
        (waitMs) => {
          if (telemetry) telemetry.bridgeQueueWaitMs = waitMs;
        }
      );
    } finally {
      this.#queuedOperations.delete(operation.operationId);
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
      const state = this.#scheduler.cancel(operationId);
      return {
        kind: "cancel_ack",
        protocolVersion: PROTOCOL_VERSION,
        operationId,
        state
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
    this.#scheduler.stop();
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
    for (const socket of this.#preauthSockets) {
      socket.terminate();
    }
    this.#preauthSockets.clear();
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

  #rotatePairingCode(): void {
    const previous = this.#pairingCode;
    let next = previous;
    while (next === previous) {
      next = String(
        Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000
      ).padStart(6, "0");
    }
    this.#pairingCode = next;
    this.#pairingExpiresAt = Date.now() + 5 * 60_000;
  }

  #lockPairing(): void {
    this.#pairingLockedUntil = Date.now() + this.#pairingLockoutMs;
    this.#rotatePairingCode();
  }

  #accept(socket: WebSocket, origin: string | undefined): void {
    const extensionId = origin?.slice("chrome-extension://".length) ?? null;
    if (!extensionId || this.#preauthSockets.size >= MAX_PREAUTH_CONNECTIONS) {
      socket.close(1013, "too many unauthenticated connections");
      return;
    }
    this.#preauthSockets.add(socket);
    let authenticated = false;
    let handshake: HandshakeState | null = null;
    let messageTail = Promise.resolve();
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.close(1008, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    socket.on("message", (raw) => {
      messageTail = messageTail.then(async () => {
        const rawBytes = Array.isArray(raw)
          ? raw.reduce((total, value) => total + value.length, 0)
          : raw.byteLength;
        if (!authenticated && rawBytes > MAX_PREAUTH_MESSAGE_BYTES) {
          throw new Error("unauthenticated message is too large");
        }
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!plainObject(parsed)) {
          throw new Error("protocol message must be an object");
        }
        const message = parsed;
        if (!authenticated) {
          const result = await this.#authenticate(
            socket,
            message,
            extensionId,
            handshake
          );
          handshake = result.handshake;
          authenticated = result.authenticated;
          if (authenticated) {
            this.#preauthSockets.delete(socket);
            clearTimeout(handshakeTimer);
          }
          return;
        }
        if (
          socket !== this.#socket
          || message.protocolVersion !== PROTOCOL_VERSION
        ) {
          throw new Error("authenticated protocol mismatch");
        }
        if (message.kind === "ping") {
          socket.send(JSON.stringify({ kind: "pong", protocolVersion: PROTOCOL_VERSION }));
          return;
        }
        if (message.kind === "result") {
          if (
            typeof message.id !== "string"
            || typeof message.operationId !== "string"
            || typeof message.ok !== "boolean"
            || (message.fingerprint !== undefined
              && typeof message.fingerprint !== "string")
          ) {
            throw new Error("invalid result envelope");
          }
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
          if (
            typeof message.operationId !== "string"
            || !["not_found", "queued", "active", "completed"].includes(
              String(message.state)
            )
          ) {
            throw new Error("invalid cancellation acknowledgement");
          }
          const ack = message as unknown as CancelAckEnvelope;
          this.#cancelAcks.get(ack.operationId)?.(ack);
          return;
        }
        throw new Error("unknown authenticated protocol message");
      }).catch(() => {
        socket.close(1008, "invalid protocol message");
      });
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.#preauthSockets.delete(socket);
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
    extensionId: string,
    handshake: HandshakeState | null
  ): Promise<{ authenticated: boolean; handshake: HandshakeState | null }> {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      if (!this.#socket) {
        this.#state = "version_mismatch";
      }
      socket.send(JSON.stringify({
        kind: "version_mismatch",
        protocolVersion: PROTOCOL_VERSION
      }));
      socket.close(1008, "protocol version mismatch");
      return { authenticated: false, handshake };
    }
    if (!handshake) {
      if (message.kind !== "hello") {
        throw new Error("hello required");
      }
      const hello = message as unknown as HelloEnvelope;
      if (
        hello.extensionId !== extensionId
        || typeof hello.extensionVersion !== "string"
        || hello.extensionVersion.length < 1
        || hello.extensionVersion.length > 64
        || !nonce(hello.clientNonce)
      ) {
        throw new Error("invalid extension hello");
      }
      const next: HandshakeState = {
        phase: "hello",
        connectionId: randomUUID(),
        clientNonce: hello.clientNonce,
        serverNonce: randomBytes(32).toString("base64url"),
        extensionNonce: "",
        extensionId,
        extensionVersion: hello.extensionVersion,
        messages: 1
      };
      if (hello.hasPairingToken === true && this.#pairingToken) {
        next.phase = "auth_challenge";
        socket.send(JSON.stringify({
          kind: "auth_challenge",
          protocolVersion: PROTOCOL_VERSION,
          connectionId: next.connectionId,
          clientNonce: next.clientNonce,
          serverNonce: next.serverNonce
        }));
        return { authenticated: false, handshake: next };
      }
      if (Date.now() < this.#pairingLockedUntil) {
        socket.close(1008, "pairing temporarily locked");
        return { authenticated: false, handshake: next };
      }
      if (this.#pairingLockedUntil > 0) {
        this.#pairingLockedUntil = 0;
        this.#pairingAttempts = 0;
      }
      if (!this.#pairingCode || Date.now() > this.#pairingExpiresAt) {
        this.#rotatePairingCode();
      }
      next.phase = "pairing_required";
      if (!this.#socket) this.#state = "pairing_required";
      socket.send(JSON.stringify({
        kind: "pairing_required",
        protocolVersion: PROTOCOL_VERSION,
        connectionId: next.connectionId,
        clientNonce: next.clientNonce,
        serverNonce: next.serverNonce
      }));
      this.emit("pairing", this.status());
      return { authenticated: false, handshake: next };
    }
    handshake.messages += 1;
    if (handshake.messages > MAX_PREAUTH_MESSAGES) {
      throw new Error("too many handshake messages");
    }
    if (
      handshake.phase === "pairing_required"
      && message.kind === "pairing_approve"
    ) {
      this.#pairingAttempts += 1;
      if (
        Date.now() > this.#pairingExpiresAt
        || message.code !== this.#pairingCode
        || message.connectionId !== handshake.connectionId
        || message.clientNonce !== handshake.clientNonce
        || message.serverNonce !== handshake.serverNonce
        || !nonce(message.extensionNonce)
      ) {
        if (this.#pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
          this.#lockPairing();
          socket.close(1008, "pairing temporarily locked");
        } else {
          socket.close(1008, "pairing attempt rejected");
        }
        return { authenticated: false, handshake };
      }
      handshake.extensionNonce = message.extensionNonce;
      const transcript = handshakeTranscript({
        ...handshake,
        protocolVersion: PROTOCOL_VERSION
      });
      const pairingCode = this.#pairingCode;
      if (!pairingCode) {
        throw new Error("pairing code expired");
      }
      const pairingKey = derivePairingKey(pairingCode, transcript);
      handshake.phase = "pairing_proof";
      socket.send(JSON.stringify({
        kind: "pairing_approved",
        protocolVersion: PROTOCOL_VERSION,
        connectionId: handshake.connectionId,
        clientNonce: handshake.clientNonce,
        serverNonce: handshake.serverNonce,
        extensionNonce: handshake.extensionNonce,
        brokerProof: hmacSha256(
          pairingKey,
          `broker-pairing:${transcript}`
        )
      }));
      return { authenticated: false, handshake };
    }
    if (
      handshake.phase === "pairing_proof"
      && message.kind === "pairing_confirm"
      && message.connectionId === handshake.connectionId
    ) {
      const transcript = handshakeTranscript({
        ...handshake,
        protocolVersion: PROTOCOL_VERSION
      });
      const pairingKey = derivePairingKey(String(this.#pairingCode), transcript);
      const expected = hmacSha256(
        pairingKey,
        `extension-pairing:${transcript}`
      );
      if (
        typeof message.extensionProof !== "string"
        || !tokensEqual(message.extensionProof, expected)
      ) {
        throw new Error("extension pairing proof failed");
      }
      const token = await createPairingToken();
      this.#pairingToken = token;
      this.#pairingCode = null;
      this.#pairingExpiresAt = 0;
      this.#pairingAttempts = 0;
      this.#pairingLockedUntil = 0;
      if (!this.#socket) this.#state = "not_running";
      socket.send(JSON.stringify({
        kind: "pairing_complete",
        protocolVersion: PROTOCOL_VERSION,
        connectionId: handshake.connectionId,
        token
      }));
      return { authenticated: false, handshake };
    }
    if (
      handshake.phase === "auth_challenge"
      && message.kind === "auth_response"
      && message.connectionId === handshake.connectionId
      && message.clientNonce === handshake.clientNonce
      && message.serverNonce === handshake.serverNonce
      && nonce(message.extensionNonce)
      && typeof message.extensionProof === "string"
      && this.#pairingToken
    ) {
      handshake.extensionNonce = message.extensionNonce;
      const transcript = handshakeTranscript({
        ...handshake,
        protocolVersion: PROTOCOL_VERSION
      });
      const expected = hmacSha256(
        this.#pairingToken,
        `extension:${transcript}`
      );
      if (!tokensEqual(message.extensionProof, expected)) {
        throw new Error("extension authentication failed");
      }
      handshake.phase = "auth_proof";
      socket.send(JSON.stringify({
        kind: "broker_proof",
        protocolVersion: PROTOCOL_VERSION,
        connectionId: handshake.connectionId,
        proof: hmacSha256(this.#pairingToken, `broker:${transcript}`)
      }));
      return { authenticated: false, handshake };
    }
    if (
      handshake.phase === "auth_proof"
      && message.kind === "auth_confirm"
      && message.connectionId === handshake.connectionId
      && typeof message.proof === "string"
      && this.#pairingToken
    ) {
      const transcript = handshakeTranscript({
        ...handshake,
        protocolVersion: PROTOCOL_VERSION
      });
      const expected = hmacSha256(
        this.#pairingToken,
        `confirm:${transcript}`
      );
      if (!tokensEqual(message.proof, expected)) {
        throw new Error("extension authentication confirmation failed");
      }
      this.#socket?.close(1000, "replaced by new extension connection");
      this.#socket = socket;
      this.#extensionId = handshake.extensionId;
      this.#extensionVersion = handshake.extensionVersion;
      this.#connectedAt = new Date().toISOString();
      this.#state = "connected";
      socket.send(JSON.stringify({
        kind: "ready",
        protocolVersion: PROTOCOL_VERSION
      }));
      this.emit("connected", this.status());
      return { authenticated: true, handshake };
    }
    throw new Error("unexpected handshake message");
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
