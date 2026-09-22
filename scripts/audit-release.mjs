import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import {
  releasePathViolations,
  secretRuleMatches
} from "./release-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", "dist", "temp"]);
const textExtensions = new Set([
  ".js", ".mjs", ".ts", ".json", ".md", ".html", ".css",
  ".yml", ".yaml", ".txt", ".ps1"
]);
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
      const rel = relative(root, path).replaceAll("\\", "/");
      const pathViolations = releasePathViolations(rel);
      if (pathViolations.length > 0) {
        for (const violation of pathViolations) {
          violations.push(`${rel}: ${violation}`);
        }
        continue;
      }
      await walk(path);
      continue;
    }
    const rel = relative(root, path).replaceAll("\\", "/");
    const pathViolations = releasePathViolations(rel);
    if (pathViolations.length > 0) {
      for (const violation of pathViolations) {
        violations.push(`${rel}: ${violation}`);
      }
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
    for (const rule of secretRuleMatches(content)) {
      violations.push(`${rel}: secret-like content (${rule})`);
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
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const protocolPackage = JSON.parse(await readFile(
  join(root, "packages", "protocol", "package.json"),
  "utf8"
));
const harnessPackage = JSON.parse(await readFile(
  join(root, "packages", "test-harness", "package.json"),
  "utf8"
));
const marketplace = JSON.parse(await readFile(
  join(root, ".factory-plugin", "marketplace.json"),
  "utf8"
));
const versions = new Set([
  rootPackage.version,
  manifest.version,
  mcpPackage.version,
  protocolPackage.version,
  harnessPackage.version,
  plugin.version,
  marketplace.plugins?.[0]?.version
]);
if (versions.size !== 1) {
  violations.push(`version mismatch: ${[...versions].join(", ")}`);
}
const expectedOverrides = {
  "fast-uri": "3.1.8",
  hono: "4.13.8",
  qs: "6.16.0"
};
for (const [name, expected] of Object.entries(expectedOverrides)) {
  if (rootPackage.overrides?.[name] !== expected) {
    violations.push(`package.json: missing exact ${name} override ${expected}`);
  }
}
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
for (const [name, expected] of Object.entries(expectedOverrides)) {
  const resolutions = Object.entries(lock.packages || {})
    .filter(([path]) => path === `node_modules/${name}`
      || path.endsWith(`/node_modules/${name}`))
    .map(([path, metadata]) => ({
      path,
      version: metadata?.version
    }));
  if (resolutions.length === 0) {
    violations.push(`package-lock.json: ${name} has no resolved package`);
  }
  for (const resolution of resolutions) {
    if (resolution.version !== expected) {
      violations.push(
        `package-lock.json: ${resolution.path} resolves ${resolution.version || "unknown"}, expected ${expected}`
      );
    }
  }
}

const expectedExtensionEntries = [
  "background.js", "content.js", "manifest.json", "popup.html", "popup.js",
  "security.js", "stage-one.js", "stage-two.js", "stage-three.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png",
  "icons/icon128.png"
].sort();

async function filesUnder(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      entries.push(...await filesUnder(path, relativePath));
    } else if (entry.isFile()) {
      entries.push(relativePath);
    } else {
      violations.push(`${relativePath}: unsupported extension entry`);
    }
  }
  return entries.sort();
}

const sourceEntries = await filesUnder(join(root, "apps", "extension"));
const unexpectedSourceEntries = sourceEntries.filter((entry) =>
  entry !== "icons/source.svg" && entry !== "icons/icon1024.png"
  && !expectedExtensionEntries.includes(entry));
const missingSourceEntries = expectedExtensionEntries.filter((entry) =>
  !sourceEntries.includes(entry));
if (unexpectedSourceEntries.length || missingSourceEntries.length) {
  violations.push(
    `apps/extension: allowlist mismatch missing=${missingSourceEntries.join(",")} unexpected=${unexpectedSourceEntries.join(",")}`
  );
}

const packageDirectory = join(root, "dist", "extension");
const packageEntries = await filesUnder(packageDirectory);
if (JSON.stringify(packageEntries) !== JSON.stringify(expectedExtensionEntries)) {
  violations.push(`dist/extension: exact entry mismatch ${packageEntries.join(",")}`);
}
const zipPath = join(root, "dist", `tabward-extension-${manifest.version}.zip`);
const zipEntries = execFileSync("powershell.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", join(root, "scripts", "list-zip-entries.ps1"),
  "-ZipPath", zipPath
], {
  encoding: "utf8",
  windowsHide: true
})
  .split(/\r?\n/)
  .map((entry) => entry.trim().replaceAll("\\", "/"))
  .filter(Boolean)
  .sort();
if (JSON.stringify(zipEntries) !== JSON.stringify(expectedExtensionEntries)) {
  violations.push(`extension ZIP: exact entry mismatch ${zipEntries.join(",")}`);
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

execFileSync(process.execPath, [
  join(root, "scripts", "scan-git-history.mjs")
], {
  stdio: "inherit",
  windowsHide: true
});

console.log(JSON.stringify({
  ok: true,
  version: manifest.version,
  secretScan: "passed",
  forbiddenFileScan: "passed"
}));
