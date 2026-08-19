import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

function artifactRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is required on Windows");
  }
  return join(localAppData, "TabWard", "artifacts");
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
