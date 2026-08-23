import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrokerRuntime {
  version: 1;
  pid: number;
  instanceId: string;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: string;
}

export function stateRoot(): string {
  const root = process.env.TABWARD_STATE_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "TabWard") : null);
  if (!root) {
    throw new Error("LOCALAPPDATA or TABWARD_STATE_DIR is required");
  }
  return root;
}

export function runtimePath(): string {
  return join(stateRoot(), "runtime.json");
}

export function startupLockPath(): string {
  return join(stateRoot(), "broker-start.lock");
}

export async function tryAcquireStartupLock(): Promise<(() => Promise<void>) | null> {
  await mkdir(stateRoot(), { recursive: true });
  try {
    const handle = await open(startupLockPath(), "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
    return async () => {
      await rm(startupLockPath(), { force: true });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

export async function clearStaleStartupLock(): Promise<void> {
  try {
    const info = await import("node:fs/promises").then(({ stat }) =>
      stat(startupLockPath())
    );
    if (Date.now() - info.mtimeMs > 15_000) {
      await rm(startupLockPath(), { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readRuntime(): Promise<BrokerRuntime | null> {
  try {
    const parsed = JSON.parse(await readFile(runtimePath(), "utf8")) as BrokerRuntime;
    return parsed.version === 1
      && parsed.host === "127.0.0.1"
      && Number.isInteger(parsed.port)
      && typeof parsed.token === "string"
      && parsed.token.length >= 43
      ? parsed
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeRuntime(
  port: number,
  instanceId: string,
  token = randomBytes(32).toString("base64url")
): Promise<BrokerRuntime> {
  const root = stateRoot();
  const target = runtimePath();
  const temporary = `${target}.${process.pid}.tmp`;
  const runtime: BrokerRuntime = {
    version: 1,
    pid: process.pid,
    instanceId,
    host: "127.0.0.1",
    port,
    token,
    startedAt: new Date().toISOString()
  };
  await mkdir(root, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(runtime, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  return runtime;
}
