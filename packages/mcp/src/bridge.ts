import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import {
  type AddressInfo
} from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createPairingToken, readPairingToken } from "./state.js";

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
}

interface ResultEnvelope {
  kind: "result";
  id: string;
  protocolVersion: number;
  ok: boolean;
  payload: unknown;
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
}

interface BridgeStatus {
  state: "not_running" | "pairing_required" | "connected" | "version_mismatch";
  extensionId: string | null;
  extensionVersion: string | null;
  pairingCode: string | null;
  connectedAt: string | null;
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
  #commandTail: Promise<void> = Promise.resolve();

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

  async send(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<unknown> {
    const previous = this.#commandTail;
    let release!: () => void;
    this.#commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await this.#sendNow(type, payload, timeoutMs);
    } finally {
      release();
    }
  }

  async #sendNow(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#state !== "connected") {
      throw new Error(
        this.#state === "pairing_required"
          ? "TabWard extension pairing is required"
          : "TabWard extension is not connected"
      );
    }
    const id = randomUUID();
    const message: CommandEnvelope = {
      kind: "command",
      id,
      protocolVersion: PROTOCOL_VERSION,
      type,
      payload
    };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`TabWard command timed out: ${type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify(message), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("TabWard bridge stopped"));
    }
    this.#pending.clear();
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
          this.#receiveResult(message as unknown as ResultEnvelope);
          socket.send(JSON.stringify({
            kind: "result_ack",
            id: message.id,
            protocolVersion: PROTOCOL_VERSION
          }));
        }
      } catch {
        socket.close(1008, "invalid protocol message");
      }
    });
    socket.on("close", () => {
      if (this.#socket === socket) {
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

  #receiveResult(result: ResultEnvelope): void {
    const pending = this.#pending.get(result.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(result.id);
    if (result.ok) {
      pending.resolve(result.payload);
      return;
    }
    const message = typeof result.payload === "object"
      && result.payload !== null
      && "message" in result.payload
      ? String((result.payload as { message: unknown }).message)
      : "TabWard extension command failed";
    pending.reject(new Error(message));
  }
}
