import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  isLocalExtensionOrigin
} from "../dist/index.js";

test("protocol constants and extension origins are bounded", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(DEFAULT_WS_PORT, 18766);
  assert.equal(
    isLocalExtensionOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
    true
  );
  assert.equal(isLocalExtensionOrigin("https://example.com"), false);
  assert.equal(isLocalExtensionOrigin(undefined), false);
});
