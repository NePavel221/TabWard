(function installTabWardSecurity(root) {
  const encoder = new TextEncoder();
  const DANGEROUS_CDP_DOMAINS = new Map([
    ["Storage", "browser-storage"],
    ["Target", "browser-targets"],
    ["Browser", "browser-global"],
    ["SystemInfo", "system-information"],
    ["Memory", "browser-memory"]
  ]);
  const SENSITIVE_CDP_METHODS = new Map([
    ["Network.getAllCookies", "authentication-data"],
    ["Network.getCookies", "authentication-data"],
    ["Network.setCookie", "authentication-data"],
    ["Network.setCookies", "authentication-data"],
    ["Network.deleteCookies", "authentication-data"],
    ["Network.clearBrowserCookies", "authentication-data"],
    ["Fetch.continueWithAuth", "authentication-data"]
  ]);
  const TAB_SCOPED_CDP_DOMAINS = new Set([
    "Accessibility", "Animation", "Audits", "CSS", "DOM", "DOMDebugger",
    "DOMSnapshot", "Emulation", "Fetch", "Input", "Inspector", "LayerTree",
    "Log", "Network", "Overlay", "Page", "Performance", "Profiler",
    "Runtime", "Schema", "Security"
  ]);
  const CROSS_TARGET_KEYS = new Set([
    "browsercontextid", "browsercontextids", "sessionid", "sessionids",
    "targetid", "targetids"
  ]);
  const SENSITIVE_KEYS = new Set([
    "accesstoken", "apikey", "auth", "authentication", "authorization",
    "bearertoken", "clientsecret", "cookie", "cookies", "credential",
    "credentials", "idtoken", "jwt", "password", "passwd",
    "proxyauthorization", "refreshtoken", "secret", "sessiontoken",
    "setcookie", "token", "xapikey"
  ]);
  const PAIRING_KDF_ITERATIONS = 150_000;

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/g, "");
  }

  function fromBase64Url(value) {
    const normalized = String(value || "")
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function randomNonce(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(",")}]`;
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  async function sha256(value) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(typeof value === "string" ? value : stableStringify(value))
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hmacSha256(token, value) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(String(token)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(typeof value === "string" ? value : stableStringify(value))
    );
    return base64Url(new Uint8Array(signature));
  }

  async function derivePairingKey(code, transcript) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(String(code)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const salt = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`tabward-pairing:${String(transcript)}`)
    );
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PAIRING_KDF_ITERATIONS
    }, material, 256);
    return base64Url(new Uint8Array(bits));
  }

  function handshakeTranscript(fields) {
    return stableStringify({
      connectionId: String(fields.connectionId || ""),
      clientNonce: String(fields.clientNonce || ""),
      serverNonce: String(fields.serverNonce || ""),
      extensionNonce: String(fields.extensionNonce || ""),
      extensionId: String(fields.extensionId || ""),
      protocolVersion: Number(fields.protocolVersion || 0)
    });
  }

  function hasCrossTargetParameter(value, key = "", depth = 0) {
    if (depth > 12) return true;
    if (CROSS_TARGET_KEYS.has(String(key).toLowerCase())) return true;
    if (Array.isArray(value)) {
      return value.some((item) => hasCrossTargetParameter(item, "", depth + 1));
    }
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([childKey, childValue]) =>
      hasCrossTargetParameter(childValue, childKey, depth + 1));
  }

  function classifyCdp(method, params = {}) {
    const exactMethod = String(method || "");
    const dot = exactMethod.indexOf(".");
    if (dot <= 0 || dot === exactMethod.length - 1) {
      return {
        ordinary: false,
        approvalRequired: true,
        category: "unknown-command",
        riskText: "Unknown CDP command shape can escape ordinary tab-scoped access."
      };
    }
    if (SENSITIVE_CDP_METHODS.has(exactMethod)) {
      return {
        ordinary: false,
        approvalRequired: true,
        category: SENSITIVE_CDP_METHODS.get(exactMethod),
        riskText: "This CDP command can read or change browser authentication data."
      };
    }
    const domain = exactMethod.slice(0, dot);
    if (DANGEROUS_CDP_DOMAINS.has(domain)) {
      return {
        ordinary: false,
        approvalRequired: true,
        category: DANGEROUS_CDP_DOMAINS.get(domain),
        riskText: "This CDP command can affect browser-global state outside the current page."
      };
    }
    if (hasCrossTargetParameter(params)) {
      return {
        ordinary: false,
        approvalRequired: true,
        category: "cross-target",
        riskText: "This CDP command names another target, session, or browser context."
      };
    }
    if (!TAB_SCOPED_CDP_DOMAINS.has(domain)) {
      return {
        ordinary: false,
        approvalRequired: true,
        category: "unknown-domain",
        riskText: "This CDP domain is not classified as ordinary tab-scoped access."
      };
    }
    return {
      ordinary: true,
      approvalRequired: false,
      category: "tab-scoped",
      riskText: "Ordinary CDP command limited to the session-owned tab."
    };
  }

  function canonicalHost(host) {
    const raw = String(host || "").trim().toLowerCase().replace(/\.$/, "");
    if (!raw || raw.includes("/") || raw.includes("@") || raw.includes(":")) {
      throw new Error("Trusted upload site must be a hostname without a scheme, path, credentials, or port");
    }
    const parsed = new URL(`https://${raw}/`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.port) {
      throw new Error("Trusted upload site is malformed");
    }
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  }

  function normalizeTrustedPattern(pattern) {
    const raw = String(pattern || "").trim().toLowerCase();
    if (raw.includes("*")) {
      throw new Error("Wildcard trusted upload sites are not allowed; use an exact host");
    }
    return canonicalHost(raw);
  }

  function trustedPatternMatches(host, pattern) {
    const normalizedHost = canonicalHost(host);
    const normalizedPattern = normalizeTrustedPattern(pattern);
    return normalizedHost === normalizedPattern;
  }

  function classifyUploadUrl(value, patterns = []) {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") {
      throw new Error("Automatic upload is allowed only on HTTPS pages");
    }
    if (url.username || url.password) {
      throw new Error("Upload pages with URL credentials are not allowed");
    }
    const host = canonicalHost(url.hostname);
    const trustedPattern = (patterns || []).find((pattern) => {
      try {
        return trustedPatternMatches(host, pattern);
      } catch {
        return false;
      }
    }) || null;
    return {
      host,
      origin: `https://${host}${url.port ? `:${url.port}` : ""}`,
      trusted: Boolean(trustedPattern),
      trustedPattern
    };
  }

  function sensitiveKey(key) {
    return SENSITIVE_KEYS.has(
      String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    );
  }

  function redactSensitiveText(value) {
    return String(value ?? "")
      .replace(
        /((?:"(?:cookie|cookies|set-cookie|authorization|proxy-authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|password|passwd|secret|session|session[-_ ]?token|token|credential|credentials|authentication|auth|jwt)"|'(?:cookie|cookies|set-cookie|authorization|proxy-authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|password|passwd|secret|session|session[-_ ]?token|token|credential|credentials|authentication|auth|jwt)'|(?:cookie|cookies|set-cookie|authorization|proxy-authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|password|passwd|secret|session|session[-_ ]?token|token|credential|credentials|authentication|auth|jwt))\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]&]+)/gi,
        "$1\"[REDACTED]\""
      )
      .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(
        /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth|authorization|cookie|token)=)[^&#\s]*/gi,
        "$1[REDACTED]"
      )
      .replace(
        /\b((?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi,
        "$1[REDACTED]"
      );
  }

  function redactBrowserPayload(value, key = "", seen = new WeakSet()) {
    if (Array.isArray(value)) {
      if (
        value.length === 2
        && typeof value[0] === "string"
        && sensitiveKey(value[0])
      ) {
        return [value[0], "[REDACTED]"];
      }
      return value.map((item) => redactBrowserPayload(item, key, seen));
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[REDACTED]";
      seen.add(value);
      const headerName = [value.name, value.key, value.header]
        .find((candidate) => typeof candidate === "string") || "";
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (sensitiveKey(childKey)) {
          result[childKey] = "[REDACTED]";
        } else if (
          childKey.toLowerCase() === "value"
          && sensitiveKey(headerName)
        ) {
          result[childKey] = "[REDACTED]";
        } else {
          result[childKey] = redactBrowserPayload(childValue, childKey, seen);
        }
      }
      seen.delete(value);
      return result;
    }
    if (typeof value === "string") {
      if (sensitiveKey(key)) return "[REDACTED]";
      return redactSensitiveText(value);
    }
    return value;
  }

  function redactNetworkBody(body, base64Encoded = false) {
    if (base64Encoded) return "[REDACTED]";
    const text = String(body || "");
    try {
      return JSON.stringify(redactBrowserPayload(JSON.parse(text)));
    } catch {
      return redactSensitiveText(text);
    }
  }

  function approvalMatches(record, binding, now = Date.now()) {
    if (!record || record.status !== "approved") return false;
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) return false;
    return [
      "approvalId", "kind", "operationId", "fingerprint", "sessionId",
      "tabId", "documentId", "origin", "host", "method",
      "paramsFingerprint", "fileFingerprint", "workerInstanceId"
    ].every((key) => (record[key] ?? null) === (binding[key] ?? null));
  }

  function assertEffectAuthorizationFresh(expiresAt, now = Date.now()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      const error = new Error("Browser authorization expired before dispatch");
      error.name = "ApprovalTimeout";
      throw error;
    }
  }

  function correlateCreatedTab(candidate, source, beforeIds = []) {
    if (!candidate?.id || candidate.id === source?.id) return false;
    if (new Set(beforeIds).has(candidate.id)) return false;
    return candidate.openerTabId !== undefined
      && candidate.openerTabId === source?.id;
  }

  root.TabWardSecurity = Object.freeze({
    approvalMatches,
    assertEffectAuthorizationFresh,
    canonicalHost,
    classifyCdp,
    classifyUploadUrl,
    correlateCreatedTab,
    derivePairingKey,
    fromBase64Url,
    handshakeTranscript,
    hmacSha256,
    normalizeTrustedPattern,
    randomNonce,
    redactBrowserPayload,
    redactNetworkBody,
    redactSensitiveText,
    sha256,
    stableStringify,
    trustedPatternMatches
  });
})(globalThis);
