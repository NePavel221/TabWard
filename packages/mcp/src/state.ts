import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface PairingFile {
  version: 1;
  token: string;
  createdAt: string;
}

function stateRoot(): string {
  const root = process.env.TABWARD_STATE_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "TabWard") : null);
  if (!root) {
    throw new Error("LOCALAPPDATA or TABWARD_STATE_DIR is required");
  }
  return root;
}

export function pairingPath(): string {
  return join(stateRoot(), "pairing.json");
}

export async function readPairingToken(): Promise<string | null> {
  try {
    const raw = await readFile(pairingPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PairingFile>;
    return parsed.version === 1
      && typeof parsed.token === "string"
      && parsed.token.length >= 43
      ? parsed.token
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function createPairingToken(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const root = stateRoot();
  const target = pairingPath();
  const temporary = `${target}.${process.pid}.tmp`;
  const payload: PairingFile = {
    version: 1,
    token,
    createdAt: new Date().toISOString()
  };
  await mkdir(root, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  return token;
}
