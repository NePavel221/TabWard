import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", "dist", "temp"]);
const forbiddenNames = new Set([
  ".env",
  "bridge.json",
  "bridge.runtime.json",
  "pairing.json",
  "runtime.json",
  "broker-start.lock"
]);
const forbiddenExtensions = new Set([".pem", ".key", ".log"]);
const textExtensions = new Set([
  ".js", ".mjs", ".ts", ".json", ".md", ".html", ".css",
  ".yml", ".yaml", ".txt", ".ps1"
]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/
];
const releaseResiduePatterns = [
  {
    pattern: /C:\\Users\\[^\\\s]+/i,
    message: "user-specific absolute path"
  },
  {
    pattern: /\b(?:DroidER|droider_|DROID_)/,
    message: "legacy product namespace"
  }
];
const residueScanExtensions = new Set([
  ".js", ".mjs", ".ts", ".json", ".md", ".html", ".css", ".yml", ".yaml"
]);

const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const rel = relative(root, path).replaceAll("\\", "/");
    if (forbiddenNames.has(entry.name) || forbiddenExtensions.has(extname(entry.name))) {
      violations.push(`${rel}: forbidden release file`);
      continue;
    }
    const info = await stat(path);
    if (info.size > 5 * 1024 * 1024) {
      violations.push(`${rel}: unexpected file larger than 5 MiB`);
    }
    if (!textExtensions.has(extname(entry.name))) {
      continue;
    }
    const content = await readFile(path, "utf8");
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        violations.push(`${rel}: secret-like content`);
      }
    }
    if (
      !rel.includes("/test/")
      && rel !== "TROUBLESHOOTING.md"
      && rel !== "scripts/audit-release.mjs"
      && rel !== "scripts/compare-browser-mcp.mjs"
    ) {
      for (const check of releaseResiduePatterns) {
        if (residueScanExtensions.has(extname(entry.name)) && check.pattern.test(content)) {
          violations.push(`${rel}: ${check.message}`);
        }
      }
    }
  }
}

await walk(root);

const manifest = JSON.parse(await readFile(
  join(root, "apps", "extension", "manifest.json"),
  "utf8"
));
const mcpPackage = JSON.parse(await readFile(
  join(root, "packages", "mcp", "package.json"),
  "utf8"
));
const plugin = JSON.parse(await readFile(
  join(root, "plugins", "factory", ".factory-plugin", "plugin.json"),
  "utf8"
));
const versions = new Set([manifest.version, mcpPackage.version, plugin.version]);
if (versions.size !== 1) {
  violations.push(`version mismatch: ${[...versions].join(", ")}`);
}

try {
  await stat(join(root, "plugins", "factory", "mcp.json"));
  violations.push(
    "plugins/factory/mcp.json: plugin must not register a second TabWard MCP process"
  );
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  version: manifest.version,
  secretScan: "passed",
  forbiddenFileScan: "passed"
}));
