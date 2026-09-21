import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

function artifactRoot(): string {
  if (process.env.TABWARD_STATE_DIR) return join(process.env.TABWARD_STATE_DIR, "artifacts");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is required on Windows");
  }
  return join(localAppData, "TabWard", "artifacts");
}

export async function saveQaScreenshots(
  result: Record<string, unknown>,
  requested: ReadonlyArray<{ name?: string }>,
  sessionId: string
): Promise<void> {
  if (!Array.isArray(result.screenshots)) return;
  const runId = randomUUID();
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "session";
  for (const [index, item] of result.screenshots.entries()) {
    if (typeof item !== "object" || item === null || typeof item.data !== "string") continue;
    // Only the caller can request a fixed filename. Extension default labels,
    // URLs and page text must never determine the generated artifact name.
    const name = requested[index]?.name || `qa-${safeSession}-${runId}-${index + 1}`;
    const artifact = await saveBase64Artifact(item.data, name, ".png");
    delete item.data;
    item.artifact = artifact;
  }
}

function safeName(requested: string | undefined, suffix: string): string {
  const source = basename(requested || `tabward-${randomUUID()}${suffix}`);
  const sanitized = source.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const value = sanitized || `tabward-${randomUUID()}${suffix}`;
  return extname(value) ? value : `${value}${suffix}`;
}

export async function saveBase64Artifact(
  data: string,
  requested: string | undefined,
  suffix: string
): Promise<Record<string, unknown>> {
  const root = artifactRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, safeName(requested, suffix));
  const bytes = Buffer.from(data, "base64");
  await writeFile(path, bytes, { flag: "wx" });
  return { path, bytes: bytes.length };
}

export async function saveJsonArtifact(
  value: unknown,
  requested: string | undefined,
  suffix = ".json"
): Promise<Record<string, unknown>> {
  const root = artifactRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, safeName(requested, suffix));
  const content = `${JSON.stringify(value)}\n`;
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  return { path, bytes: Buffer.byteLength(content) };
}
