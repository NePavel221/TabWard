import assert from "node:assert/strict";
import test from "node:test";
import { AcceptedWorkTracker } from "../dist/accepted-work.js";

test("session close drain waits for accepted work and ignores other sessions", async () => {
  const tracker = new AcceptedWorkTracker();
  const order = [];
  let releaseA;
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const acceptedA = tracker.run("a", async () => {
    order.push("a-start");
    await holdA;
    order.push("a-end");
  });
  const acceptedB = tracker.run("b", async () => {
    order.push("b");
  });
  const closeA = tracker.wait("a").then(() => order.push("a-cleanup"));
  await acceptedB;
  assert.equal(order.includes("a-cleanup"), false);
  releaseA();
  await Promise.all([acceptedA, closeA]);
  assert.deepEqual(order, ["a-start", "b", "a-end", "a-cleanup"]);
  assert.equal(tracker.count("a"), 0);
  assert.equal(tracker.count("b"), 0);
});

test("accepted-work tracker drains failures without leaks", async () => {
  const tracker = new AcceptedWorkTracker();
  await assert.rejects(
    tracker.run("a", async () => {
      throw new Error("synthetic failure");
    }),
    /synthetic failure/
  );
  await tracker.wait("a");
  assert.equal(tracker.count("a"), 0);
});
