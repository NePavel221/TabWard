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

test("managed sessions include bounded frontend QA capabilities", () => {
  const policy = new SessionPolicy();
  const session = policy.start({ cleanQa: true });
  for (const capability of [
    "action", "artifacts", "downloads", "emulation", "evaluate_local",
    "events", "probes", "tracing", "uploads"
  ]) {
    assert.equal(session.capabilities.has(capability), true, capability);
  }
  assert.equal(session.capabilities.has("evaluate"), false);
  assert.equal(session.capabilities.has("storage"), false);
  assert.equal(session.cleanQa, true);
  assert.equal(session.cleanQaTainted, false);
});

test("managed sessions reject full-profile evaluate", () => {
  const policy = new SessionPolicy();
  assert.throws(
    () => policy.start({ capabilities: ["read", "evaluate"] }),
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
