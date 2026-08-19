import assert from "node:assert/strict";
import test from "node:test";
import { SessionPolicy } from "../dist/session.js";

test("managed sessions use the tabward namespace", () => {
  const policy = new SessionPolicy();
  const session = policy.start({ name: "test", ttlSeconds: 60 });
  assert.match(session.id, /^tabward-[a-f0-9]{32}$/);
  assert.equal(session.workspace, "current");
  assert.equal(policy.active().length, 1);
  policy.close(session.id);
  assert.equal(policy.active().length, 0);
});

test("managed sessions reject privileged capabilities", () => {
  const policy = new SessionPolicy();
  assert.throws(
    () => policy.start({ capabilities: ["read", "cdp"] }),
    /require full_profile/
  );
});

test("a tab cannot be owned by two sessions", () => {
  const policy = new SessionPolicy();
  const first = policy.start({ name: "first" });
  const second = policy.start({ name: "second" });
  policy.assignTab(first.id, 42, { created: true });
  assert.throws(
    () => policy.assignTab(second.id, 42),
    /already owned/
  );
});
