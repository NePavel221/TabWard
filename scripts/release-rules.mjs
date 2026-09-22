import { basename, extname } from "node:path";

export const forbiddenNames = new Set([
  ".env",
  "bridge.json",
  "bridge.runtime.json",
  "pairing.json",
  "runtime.json",
  "broker-start.lock"
]);

export const forbiddenExtensions = new Set([
  ".crx", ".db", ".har", ".key", ".log", ".pem", ".sqlite",
  ".tgz", ".trace", ".zip"
]);

export const forbiddenDirectoryNames = new Set([
  "artifacts", "browser-data", "downloads", "profiles", "reports",
  "sessions", "traces"
]);

export const secretRules = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  },
  {
    id: "github-token",
    pattern: /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/
  },
  {
    id: "openai-token",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/
  },
  {
    id: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    id: "telegram-bot-token",
    pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
  },
  {
    id: "personal-windows-path",
    pattern: /[A-Za-z]:\\Users\\[^\\\r\n]+/i
  }
];

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function releasePathViolations(value) {
  const path = normalizedPath(value);
  const segments = path.toLowerCase().split("/").filter(Boolean);
  const name = basename(path).toLowerCase();
  const violations = [];
  if (forbiddenNames.has(name)) {
    violations.push("forbidden release file");
  }
  if (forbiddenExtensions.has(extname(name))) {
    violations.push("forbidden release file extension");
  }
  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    violations.push("forbidden release directory");
  }
  return violations;
}

export function secretRuleMatches(content) {
  const value = typeof content === "string"
    ? content
    : Buffer.from(content).toString("latin1");
  return secretRules
    .filter((rule) => rule.pattern.test(value))
    .map((rule) => rule.id);
}
