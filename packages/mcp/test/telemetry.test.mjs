import assert from "node:assert/strict";
import test from "node:test";
import {
  newTelemetry,
  sanitizeTelemetry,
  telemetryEnabled
} from "../dist/telemetry.js";

test("telemetry is opt-in and uses a closed non-sensitive schema", () => {
  const previous = process.env.TABWARD_TELEMETRY;
  delete process.env.TABWARD_TELEMETRY;
  try {
    assert.equal(telemetryEnabled(), false);
    process.env.TABWARD_TELEMETRY = "1";
    assert.equal(telemetryEnabled(), true);
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const clean = sanitizeTelemetry({
      ...newTelemetry("fill", operationId),
      bridgeQueueWaitMs: 12.5,
      schedulerActiveCount: 2,
      schedulerConfiguredMax: 2,
      schedulerMaxObservedActive: 2,
      resultBytes: 42,
      url: "https://secret.example/private",
      selector: "#password",
      value: "hunter2",
      path: "C:\\private\\document.pdf",
      payload: { cookie: "secret" },
      result: "<main>private page</main>"
    });
    assert.deepEqual(clean, {
      operationId,
      operationType: "fill",
      bridgeQueueWaitMs: 12.5,
      schedulerActiveCount: 2,
      schedulerConfiguredMax: 2,
      schedulerMaxObservedActive: 2,
      resultBytes: 42
    });
    assert.doesNotMatch(JSON.stringify(clean), /secret|password|hunter2|private|cookie/i);
  } finally {
    if (previous === undefined) delete process.env.TABWARD_TELEMETRY;
    else process.env.TABWARD_TELEMETRY = previous;
  }
});

test("unknown operation names are not copied into telemetry", () => {
  const sample = newTelemetry("navigate https://secret.example");
  assert.equal(sample.operationType, "unknown");
  assert.doesNotMatch(JSON.stringify(sample), /secret|example/i);
});
