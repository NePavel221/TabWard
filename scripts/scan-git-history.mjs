import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  releasePathViolations,
  secretRuleMatches,
  secretRules
} from "./release-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const MAX_HISTORY_BLOB_BYTES = 128 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    windowsHide: true
  });
}

const objects = git(["rev-list", "--objects", "--all"])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const separator = line.indexOf(" ");
    return separator < 0
      ? { object: line, path: null }
      : { object: line.slice(0, separator), path: line.slice(separator + 1) };
  })
  .filter((entry) => entry.path);
const violations = [];
const scannedObjects = new Set();
let blobsScanned = 0;
let bytesScanned = 0;

for (const entry of objects) {
  for (const violation of releasePathViolations(entry.path)) {
    violations.push({
      rule: "forbidden-path",
      detail: violation,
      path: entry.path,
      object: entry.object
    });
  }
  if (!scannedObjects.has(entry.object)) {
    scannedObjects.add(entry.object);
    const type = git(["cat-file", "-t", entry.object]).trim();
    if (type !== "blob") continue;
    const size = Number(git(["cat-file", "-s", entry.object]).trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Could not determine blob size for ${entry.object}`);
    }
    if (size > MAX_HISTORY_BLOB_BYTES) {
      violations.push({
        rule: "oversized-history-blob",
        path: entry.path,
        object: entry.object,
        size
      });
      continue;
    }
    const bytes = git(["cat-file", "blob", entry.object], {
      encoding: "buffer",
      maxBuffer: Math.max(128 * 1024 * 1024, size + 1024 * 1024)
    });
    if (bytes.length !== size) {
      throw new Error(`Incomplete blob read for ${entry.object}`);
    }
    blobsScanned += 1;
    bytesScanned += bytes.length;
    for (const rule of secretRuleMatches(bytes)) {
      violations.push({
        rule,
        path: entry.path,
        object: entry.object
      });
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(JSON.stringify(violation));
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  refs: "all",
  objectsVisited: scannedObjects.size,
  blobsScanned,
  bytesScanned,
  skippedBlobs: 0,
  rules: secretRules.map((rule) => rule.id)
}));
