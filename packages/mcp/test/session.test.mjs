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

test("closing and cleanup_partial sessions reject new commands but can retry cleanup", () => {
  const policy = new SessionPolicy();
  const session = policy.start({ name: "closing" });
  policy.assignTab(session.id, 42, { created: true });
  policy.beginClose(session.id);
  assert.throws(() => policy.require(session.id, "read"), /closing/);
  policy.cleanupPartial(session.id, { failedTabIds: [42] });
  assert.throws(() => policy.require(session.id, "read"), /cleanup_partial/);
  assert.equal(policy.beginClose(session.id).state, "closing");
  policy.close(session.id);
  assert.equal(policy.active().length, 0);
});

test("closing pins cleanup beyond the session's original expiry", () => {
  const policy = new SessionPolicy();
  const session = policy.start({ name: "expiry-boundary", ttlSeconds: 60 });
  session.expiresAt = Date.now() / 1000 + 0.01;
  const originalExpiry = session.expiresAt;
  policy.beginClose(session.id);
  assert.equal(session.expiresAt > originalExpiry + 299, true);
  session.expiresAt = Date.now() / 1000 + 0.01;
  policy.cleanupPartial(session.id, { pending: true });
  assert.equal(session.expiresAt > Date.now() / 1000 + 299, true);
  assert.equal(policy.get(session.id, false, true).state, "cleanup_partial");
});

test("four logical sessions retain isolated ownership while policy is sequential", () => {
  const policy = new SessionPolicy();
  const sessions = Array.from({ length: 4 }, (_, index) =>
    policy.start({ name: `session-${index}` }));
  sessions.forEach((session, index) => {
    policy.assignTab(session.id, 100 + index, {
      created: index % 2 === 0,
      adopted: index % 2 === 1
    });
  });
  sessions.forEach((session, index) => {
    assert.deepEqual([...session.tabIds], [100 + index]);
    assert.equal(policy.owner(100 + index)?.id, session.id);
  });
  assert.equal(policy.active().length, 4);
});
