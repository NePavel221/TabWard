import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCommand,
  FairScheduler,
  schedulerOptionsFromEnv
} from "../dist/scheduler.js";

function operation(index, timeoutMs = 5_000) {
  return {
    operationId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`,
    fingerprint: String(index).padStart(64, "0").slice(-64),
    deadlineAt: Date.now() + timeoutMs
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduler(maxConcurrency = 2, overrides = {}) {
  return new FairScheduler({
    maxConcurrency,
    maxQueuePerSession: 64,
    maxQueueTotal: 256,
    ...overrides
  });
}

test("scheduler configuration validates concurrency within 1..4", () => {
  assert.equal(schedulerOptionsFromEnv({}).maxConcurrency, 2);
  assert.equal(schedulerOptionsFromEnv({
    TABWARD_SCHEDULER_MAX_CONCURRENCY: "2"
  }).maxConcurrency, 2);
  assert.equal(schedulerOptionsFromEnv({
    TABWARD_SCHEDULER_MAX_CONCURRENCY: "4"
  }).maxConcurrency, 4);
  assert.equal(schedulerOptionsFromEnv({
    TABWARD_SCHEDULER_MAX_CONCURRENCY: "0"
  }).maxConcurrency, 2);
  assert.equal(schedulerOptionsFromEnv({
    TABWARD_SCHEDULER_MAX_CONCURRENCY: "5"
  }).maxConcurrency, 2);
});

test("one session is FIFO while different sessions overlap", async () => {
  const subject = scheduler(2);
  const order = [];
  let active = 0;
  let maxActive = 0;
  const run = (index, sessionId, wait) => subject.schedule(
    operation(index),
    classifyCommand("ping", { sessionId }),
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${sessionId}-${index}`);
      await delay(wait);
      order.push(`end-${sessionId}-${index}`);
      active -= 1;
    }
  );
  await Promise.all([
    run(1, "a", 25),
    run(2, "a", 1),
    run(3, "b", 10)
  ]);
  assert.equal(maxActive, 2);
  assert.equal(
    order.indexOf("end-a-1") < order.indexOf("start-a-2"),
    true
  );
  assert.equal(
    order.indexOf("start-b-3") < order.indexOf("end-a-1"),
    true
  );
});

for (const maximum of [1, 2, 4]) {
  test(`scheduler never exceeds configured maximum ${maximum}`, async () => {
    const subject = scheduler(maximum);
    let active = 0;
    let observed = 0;
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      subject.schedule(
        operation(100 + maximum * 20 + index),
        classifyCommand("ping", { sessionId: `session-${index}` }),
        async () => {
          active += 1;
          observed = Math.max(observed, active);
          await delay(5);
          active -= 1;
        }
      )
    ));
    assert.equal(observed, maximum);
    assert.equal(subject.metrics().active, 0);
    assert.equal(subject.metrics().queued, 0);
  });
}

test("round-robin fairness serves a sparse session during a flood", async () => {
  const subject = scheduler(2);
  const started = [];
  const jobs = [];
  jobs.push(subject.schedule(
    operation(200),
    classifyCommand("ping", { sessionId: "flood" }),
    async () => {
      started.push("flood-0");
      await delay(15);
    }
  ));
  for (let index = 1; index <= 8; index += 1) {
    jobs.push(subject.schedule(
      operation(200 + index),
      classifyCommand("ping", { sessionId: "flood" }),
      async () => started.push(`flood-${index}`)
    ));
  }
  jobs.push(subject.schedule(
    operation(220),
    classifyCommand("ping", { sessionId: "sparse" }),
    async () => started.push("sparse")
  ));
  await Promise.all(jobs);
  assert.equal(started.indexOf("sparse") <= 2, true, started.join(","));
});

test("compatibility maximum 1 preserves global Stage Two submission order", async () => {
  const subject = scheduler(1);
  const started = [];
  await Promise.all([
    subject.schedule(
      operation(230),
      classifyCommand("ping", { sessionId: "a" }),
      async () => started.push("a-1")
    ),
    subject.schedule(
      operation(231),
      classifyCommand("ping", { sessionId: "a" }),
      async () => started.push("a-2")
    ),
    subject.schedule(
      operation(232),
      classifyCommand("ping", { sessionId: "b" }),
      async () => started.push("b-1")
    )
  ]);
  assert.deepEqual(started, ["a-1", "a-2", "b-1"]);
});

test("compatibility maximum 1 preserves mixed session and global submission order", async () => {
  const subject = scheduler(1);
  const started = [];
  const jobs = [
    ["ping", "a", "A1"],
    ["storage", "b", "B-global"],
    ["ping", "c", "C1"],
    ["storage", "a", "A-global"]
  ].map(([type, sessionId, label], index) => subject.schedule(
    operation(240 + index),
    classifyCommand(type, { sessionId }),
    async () => started.push(label)
  ));
  await Promise.all(jobs);
  assert.deepEqual(started, ["A1", "B-global", "C1", "A-global"]);
});

test("queue backpressure happens before dispatch", async () => {
  const subject = scheduler(1, {
    maxQueuePerSession: 2,
    maxQueueTotal: 2
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let effects = 0;
  const first = subject.schedule(
    operation(300),
    classifyCommand("ping", { sessionId: "a" }),
    async () => {
      effects += 1;
      await hold;
    }
  );
  const queued = subject.schedule(
    operation(301),
    classifyCommand("ping", { sessionId: "a" }),
    async () => {
      effects += 1;
    }
  );
  await assert.rejects(
    subject.schedule(
      operation(302),
      classifyCommand("ping", { sessionId: "a" }),
      async () => {
        effects += 1;
      }
    ),
    (error) => {
      assert.equal(error?.name, "CapacityExceeded");
      assert.equal(error?.details?.outcome, "not_started");
      assert.equal(error?.details?.retrySafe, true);
      return true;
    }
  );
  release();
  await Promise.all([first, queued]);
  assert.equal(effects, 2);
});

test("global-exclusive flood keeps origin session admission and sparse fairness", async () => {
  const subject = scheduler(2, {
    maxQueuePerSession: 4,
    maxQueueTotal: 8
  });
  const started = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const global = (index, sessionId, run) => subject.schedule(
    operation(index),
    classifyCommand("storage", { sessionId, tabId: index }),
    async () => {
      started.push(`${sessionId}-${index}`);
      return await run();
    }
  );
  const jobs = [
    global(320, "a", async () => hold),
    global(321, "a", async () => undefined),
    global(322, "a", async () => undefined),
    global(323, "b", async () => undefined)
  ];
  release();
  await Promise.all(jobs);
  assert.deepEqual(started, ["a-320", "a-321", "b-323", "a-322"]);
});

test("global selection checks the exact A1 A2 B1 B2 barrier", async () => {
  const subject = scheduler(2);
  const started = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const active = subject.schedule(
    operation(324),
    classifyCommand("ping", { sessionId: "active" }),
    async () => {
      started.push("active");
      await hold;
    }
  );
  const a1 = subject.schedule(
    operation(325),
    classifyCommand("storage", { sessionId: "a" }),
    async () => started.push("A1")
  );
  const a2 = subject.schedule(
    operation(326),
    classifyCommand("storage", { sessionId: "a" }),
    async () => started.push("A2")
  );
  const b1 = subject.schedule(
    operation(327),
    classifyCommand("ping", { sessionId: "b" }),
    async () => started.push("B1")
  );
  const b2 = subject.schedule(
    operation(328),
    classifyCommand("storage", { sessionId: "b" }),
    async () => started.push("B2")
  );
  release();
  await Promise.all([active, a1, a2, b1, b2]);
  assert.deepEqual(started, ["active", "A1", "A2", "B1", "B2"]);
});

test("mixed session and global work stays FIFO without losing round-robin fairness", async () => {
  const subject = scheduler(3);
  const started = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const schedule = (index, type, sessionId, label) => subject.schedule(
    operation(index),
    classifyCommand(type, { sessionId }),
    async () => started.push(label)
  );
  const jobs = [
    subject.schedule(
      operation(334),
      classifyCommand("ping", { sessionId: "active" }),
      async () => {
        started.push("active");
        await hold;
      }
    ),
    schedule(335, "storage", "a", "A1"),
    schedule(336, "storage", "a", "A2"),
    schedule(337, "storage", "c", "C1"),
    schedule(338, "ping", "b", "B1"),
    schedule(339, "storage", "b", "B2"),
    schedule(340, "storage", "a", "A3"),
    schedule(341, "storage", "c", "C2")
  ];
  release();
  await Promise.all(jobs);

  assert.deepEqual(started, [
    "active",
    "A1",
    "C1",
    "A2",
    "B1",
    "C2",
    "B2",
    "A3"
  ]);
});

test("global-exclusive active plus queued work counts toward per-session backpressure", async () => {
  const subject = scheduler(2, {
    maxQueuePerSession: 2,
    maxQueueTotal: 8
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const active = subject.schedule(
    operation(330),
    classifyCommand("executeCdp", { sessionId: "a", tabId: 1 }),
    async () => hold
  );
  const queued = subject.schedule(
    operation(331),
    classifyCommand("downloadClick", { sessionId: "a", tabId: 1 }),
    async () => undefined
  );
  await assert.rejects(
    subject.schedule(
      operation(332),
      classifyCommand("releaseWorkspace", { sessionId: "a" }),
      async () => undefined
    ),
    (error) =>
      error?.name === "CapacityExceeded"
      && /per-session/.test(error?.details?.reason)
  );
  const sparse = subject.schedule(
    operation(333),
    classifyCommand("storage", { sessionId: "b", tabId: 2 }),
    async () => undefined
  );
  release();
  await Promise.all([active, queued, sparse]);
});

test("total queue backpressure spans different sessions", async () => {
  const subject = scheduler(1, {
    maxQueuePerSession: 4,
    maxQueueTotal: 2
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = subject.schedule(
    operation(350),
    classifyCommand("ping", { sessionId: "active" }),
    async () => hold
  );
  const second = subject.schedule(
    operation(351),
    classifyCommand("ping", { sessionId: "queued-a" }),
    async () => undefined
  );
  const third = subject.schedule(
    operation(352),
    classifyCommand("ping", { sessionId: "queued-b" }),
    async () => undefined
  );
  await assert.rejects(
    subject.schedule(
      operation(353),
      classifyCommand("ping", { sessionId: "queued-c" }),
      async () => undefined
    ),
    (error) =>
      error?.name === "CapacityExceeded"
      && /total queue/.test(error?.details?.reason)
  );
  release();
  await Promise.all([first, second, third]);
});

test("queued cancellation and expiry have zero effects", async () => {
  const subject = scheduler(1);
  let effects = 0;
  const first = subject.schedule(
    operation(400),
    classifyCommand("ping", { sessionId: "a" }),
    async () => {
      effects += 1;
      await delay(50);
    }
  );
  const cancelledId = operation(401).operationId;
  const cancelled = subject.schedule(
    operation(401),
    classifyCommand("ping", { sessionId: "b" }),
    async () => {
      effects += 1;
    }
  );
  const expired = subject.schedule(
    operation(402, 10),
    classifyCommand("ping", { sessionId: "c" }),
    async () => {
      effects += 1;
    }
  );
  assert.equal(subject.cancel(cancelledId), "queued");
  await assert.rejects(cancelled, (error) =>
    error?.name === "CancelledBeforeEffect");
  await assert.rejects(expired, (error) =>
    error?.name === "NotStarted" && error?.details?.retrySafe === true);
  await first;
  assert.equal(effects, 1);
});

test("same-tab work never overlaps but different tabs can overlap", async () => {
  const subject = scheduler(4);
  const activeTabs = new Set();
  let sameTabOverlap = false;
  let maxActive = 0;
  const run = (index, sessionId, tabId) => subject.schedule(
    operation(index),
    classifyCommand("getText", { sessionId, tabId }),
    async () => {
      if (activeTabs.has(tabId)) sameTabOverlap = true;
      activeTabs.add(tabId);
      maxActive = Math.max(maxActive, activeTabs.size);
      await delay(15);
      activeTabs.delete(tabId);
    }
  );
  await Promise.all([
    run(500, "a", 1),
    run(501, "b", 1),
    run(502, "c", 2),
    run(503, "d", 3)
  ]);
  assert.equal(sameTabOverlap, false);
  assert.equal(maxActive >= 3, true);
});

test("global exclusive waits for active work and blocks followers", async () => {
  const subject = scheduler(3);
  const order = [];
  const first = subject.schedule(
    operation(600),
    classifyCommand("ping", { sessionId: "a" }),
    async () => {
      order.push("first-start");
      await delay(25);
      order.push("first-end");
    }
  );
  const exclusive = subject.schedule(
    operation(601),
    classifyCommand("releaseWorkspace", { sessionId: "a" }),
    async () => {
      order.push("global-start");
      await delay(10);
      order.push("global-end");
    }
  );
  const follower = subject.schedule(
    operation(602),
    classifyCommand("ping", { sessionId: "b" }),
    async () => order.push("follower")
  );
  await Promise.all([first, exclusive, follower]);
  assert.deepEqual(order, [
    "first-start",
    "first-end",
    "global-start",
    "global-end",
    "follower"
  ]);
});

test("unknown scope, expert CDP, Clean QA, and correlation-sensitive downloads are global", () => {
  assert.equal(classifyCommand("ping", {}).kind, "global");
  assert.equal(classifyCommand("cdp", {
    sessionId: "a",
    tabId: 1,
    method: "Unknown.enable"
  }).kind, "global");
  assert.equal(classifyCommand("executeCdp", {
    sessionId: "a",
    tabId: 1,
    method: "Runtime.evaluate"
  }).kind, "global");
  assert.equal(classifyCommand("futureUnknownCommand", {
    sessionId: "a",
    tabId: 1
  }).kind, "global");
  assert.equal(classifyCommand("nameSession", {
    sessionId: "a",
    cleanQa: true
  }).kind, "global");
  assert.equal(classifyCommand("downloadClick", {
    sessionId: "a",
    tabId: 1
  }).kind, "global");
});

test("legacy executeCdp and unknown commands cannot overlap unrelated sessions", async () => {
  for (const [offset, type] of ["executeCdp", "futureUnknownCommand"].entries()) {
    const subject = scheduler(4);
    let active = 0;
    let overlap = false;
    const global = subject.schedule(
      operation(650 + offset * 10),
      classifyCommand(type, { sessionId: "a", tabId: 1 }),
      async () => {
        active += 1;
        await delay(10);
        active -= 1;
      }
    );
    const unrelated = subject.schedule(
      operation(651 + offset * 10),
      classifyCommand("getText", { sessionId: "b", tabId: 2 }),
      async () => {
        if (active > 0) overlap = true;
      }
    );
    await Promise.all([global, unrelated]);
    assert.equal(overlap, false, type);
  }
});

test("50-cycle scheduler endurance leaves no queue, lock, or active entry", async () => {
  const subject = scheduler(4);
  for (let cycle = 0; cycle < 50; cycle += 1) {
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      subject.schedule(
        operation(700 + cycle * 4 + index),
        classifyCommand("getText", {
          sessionId: `session-${index}`,
          tabId: index + 1
        }),
        async () => delay(1)
      )
    ));
  }
  assert.deepEqual(subject.metrics(), {
    active: 0,
    queued: 0,
    configuredMax: 4,
    maxObservedActive: 4
  });
});
