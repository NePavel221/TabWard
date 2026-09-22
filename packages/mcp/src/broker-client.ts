import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearStaleStartupLock,
  readRuntime,
  tryAcquireStartupLock,
  type BrokerRuntime
} from "./runtime.js";
import {
  commandFingerprint,
  outcomeUnknown,
  remainingMs
} from "./operation.js";
import { newTelemetry, sanitizeTelemetry, telemetryEnabled, type OperationTelemetry } from "./telemetry.js";

type Health = Record<string, unknown> & {
  instanceId?: unknown;
  extension?: Record<string, unknown>;
};

class BrokerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly remoteName?: string,
    readonly telemetry?: unknown,
    readonly details?: unknown
  ) {
    super(message);
    this.name = remoteName || "BrokerRequestError";
  }
}

const READ_ONLY_COMMANDS = new Set([
  "ping", "tabs", "observe", "getText", "getHtml", "getPageState",
  "extractTables", "extractImages", "queryRich", "locatorWait",
  "locatorAssert", "eventsPoll", "networkBody", "networkHar",
  "downloads", "getUserSettings"
]);

export function operationRequest(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  operationId: string = randomUUID(),
  requestId: string = randomUUID(),
  deadlineAt = Date.now() + timeoutMs,
  telemetry = false
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    requestId,
    command,
    payload,
    timeoutMs,
    operationId,
    fingerprint: commandFingerprint(command, payload),
    deadlineAt,
    ...(telemetry ? { telemetry: true } : {})
  });
}

function endpoint(runtime: BrokerRuntime, path: string): string {
  return `http://${runtime.host}:${runtime.port}${path}`;
}

async function request(
  runtime: BrokerRuntime,
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint(runtime, path), {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok || value.ok === false) {
    throw new BrokerRequestError(
      response.status,
      String(value.error || `TabWard broker HTTP ${response.status}`),
      typeof value.name === "string" ? value.name : undefined,
      value.telemetry,
      value.details
    );
  }
  return value;
}

async function healthy(runtime: BrokerRuntime | null): Promise<Health | null> {
  if (!runtime) return null;
  try {
    const health = await request(runtime, "/health") as Health;
    return health.instanceId === runtime.instanceId ? health : null;
  } catch {
    return null;
  }
}

export class BrokerClient {
  readonly host = "127.0.0.1";
  #runtime: BrokerRuntime | null = null;
  #health: Health | null = null;
  #telemetry: OperationTelemetry[] = [];

  telemetry(): OperationTelemetry[] {
    return telemetryEnabled() ? this.#telemetry.map((sample) => ({ ...sample })) : [];
  }

  get port(): number {
    const extension = this.#health?.extension;
    return typeof extension?.port === "number" ? extension.port : 18766;
  }

  async start(): Promise<void> {
    let runtime = await readRuntime();
    let health = await healthy(runtime);
    if (!health) {
      await clearStaleStartupLock();
      const releaseLock = await tryAcquireStartupLock();
      if (releaseLock) {
        try {
          runtime = await readRuntime();
          health = await healthy(runtime);
          if (!health) {
            const entry = resolve(fileURLToPath(new URL(".", import.meta.url)), "broker-server.js");
            const child = spawn(process.execPath, [entry], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: process.env
            });
            child.unref();
          }
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
            runtime = await readRuntime();
            health = await healthy(runtime);
            if (runtime && health) break;
          }
        } finally {
          await releaseLock();
        }
      } else {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
          runtime = await readRuntime();
          health = await healthy(runtime);
          if (runtime && health) break;
        }
      }
    }
    if (!runtime || !health) {
      throw new Error("TabWard broker failed to start; check ports 18766 and 18767");
    }
    this.#runtime = runtime;
    this.#health = health;
  }

  status(): Record<string, unknown> {
    return {
      state: this.#health?.extension?.state ?? "not_running",
      extensionId: this.#health?.extension?.extensionId ?? null,
      extensionVersion: this.#health?.extension?.extensionVersion ?? null,
      pairingCode: this.#health?.extension?.pairingCode ?? null,
      connectedAt: this.#health?.extension?.connectedAt ?? null,
      broker: this.#health ? {
        pid: this.#health.pid,
        instanceId: this.#health.instanceId,
        uptimeSeconds: this.#health.uptimeSeconds,
        activeRequests: this.#health.activeRequests
      } : null
    };
  }

  async refresh(): Promise<void> {
    const runtime = this.#runtime ?? await readRuntime();
    const health = await healthy(runtime);
    if (!runtime || !health) throw new Error("TabWard broker is unavailable");
    this.#runtime = runtime;
    this.#health = health;
  }

  async waitForExtension(timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refresh();
      if (this.#health?.extension?.state === "connected") return;
      if (this.#health?.extension?.state === "version_mismatch") {
        throw new Error("TabWard MCP and extension protocol versions do not match");
      }
      if (this.#health?.extension?.state === "pairing_required") {
        throw new Error("TabWard extension pairing is required");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error("TabWard extension did not reconnect to the broker");
  }

  async send(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 60_000
  ): Promise<unknown> {
    if (!this.#runtime) await this.start();
    const metrics = telemetryEnabled() ? newTelemetry(command) : undefined;
    const startedAt = performance.now();
    const operationId = metrics?.operationId ?? randomUUID();
    const deadlineAt = Date.now() + timeoutMs;
    const operation = operationRequest(
      command,
      payload,
      timeoutMs,
      operationId,
      randomUUID(),
      deadlineAt,
      Boolean(metrics)
    );
    const record = (value: unknown) => {
      if (!metrics) return;
      const sample = sanitizeTelemetry(value);
      if (!sample || sample.operationId !== metrics.operationId) return;
      sample.operationType = metrics.operationType;
      sample.clientTotalMs = performance.now() - startedAt;
      this.#telemetry = [
        ...this.#telemetry.filter((entry) => entry.operationId !== sample.operationId),
        sample
      ].slice(-128);
    };
    const execute = async () => {
      const budget = remainingMs(deadlineAt);
      if (budget === 0) {
        const error = new Error(`NotStarted: deadline expired before ${command} dispatch`);
        error.name = "NotStarted";
        throw error;
      }
      try {
        const value = await request(this.#runtime!, "/command", {
          method: "POST",
          body: JSON.stringify(operation)
        }, budget + 5_000);
        record(value.telemetry);
        return value;
      } catch (error) {
        if (error instanceof BrokerRequestError) record(error.telemetry);
        throw error;
      }
    };
    try {
      const value = await execute();
      return value.result;
    } catch (error) {
      if (error instanceof BrokerRequestError) {
        throw error;
      }
      const previousInstance = this.#runtime?.instanceId;
      try {
        await this.refresh();
      } catch {
        if (READ_ONLY_COMMANDS.has(command)) {
          await this.start();
          await this.waitForExtension();
        } else {
          throw outcomeUnknown(`broker connection was lost while ${command} was running`);
        }
      }
      if (this.#runtime?.instanceId !== previousInstance) {
        if (!READ_ONLY_COMMANDS.has(command)) {
          throw outcomeUnknown(`broker restarted while ${command} was running`);
        }
        await this.waitForExtension();
        const value = await execute();
        return value.result;
      }
      // Repeating the same operationId against the same broker only joins its
      // ledger promise or returns its confirmed cached result.
      if (remainingMs(deadlineAt) === 0) {
        throw outcomeUnknown(`deadline expired after ${command} may have reached the broker`);
      }
      const value = await execute();
      return value.result;
    }
  }

  async cancel(operationId: string): Promise<Record<string, unknown>> {
    if (!this.#runtime) await this.start();
    return request(this.#runtime!, "/cancel", {
      method: "POST",
      body: JSON.stringify({ operationId })
    }, 5_000);
  }

  async stop(): Promise<void> {
    if (process.env.TABWARD_BROKER_EPHEMERAL === "1" && this.#runtime) {
      await request(this.#runtime, "/shutdown", { method: "POST" }).catch(() => {});
    }
  }
}
