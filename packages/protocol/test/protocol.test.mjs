import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WS_PORT,
  HANDSHAKE_TIMEOUT_MS,
  MAX_PREAUTH_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  isLocalExtensionOrigin
} from "../dist/index.js";

test("protocol constants and extension origins are bounded", () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.equal(DEFAULT_WS_PORT, 18766);
  assert.equal(MAX_PREAUTH_MESSAGE_BYTES, 64 * 1024);
  assert.equal(HANDSHAKE_TIMEOUT_MS, 10_000);
  assert.equal(
    isLocalExtensionOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
    true
  );
  assert.equal(isLocalExtensionOrigin("https://example.com"), false);
  assert.equal(isLocalExtensionOrigin(undefined), false);
});
