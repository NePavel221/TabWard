import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

async function benchmarkTempDirs() {
  return new Set((await readdir(tmpdir()))
    .filter((name) => name.startsWith("tabward-stage3-benchmark-")));
}

test("benchmark cleans its child and temp directory when fixture startup fails", { timeout: 15_000 }, async () => {
  const before = await benchmarkTempDirs();
  const entry = resolve(import.meta.dirname, "..", "..", "..", "scripts", "benchmark-stage-one.mjs");
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TABWARD_BENCH_FAIL_AFTER_SPAWN: "1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("exit", resolveExit);
    child.once("error", reject);
  });
  assert.notEqual(exitCode, 0);
  const match = stderr.match(/Injected benchmark fixture failure for child (\d+)/);
  assert.ok(match);
  const brokerPid = Number(match[1]);
  assert.throws(
    () => process.kill(brokerPid, 0),
    (error) => error?.code === "ESRCH"
  );
  const after = await benchmarkTempDirs();
  assert.deepEqual(after, before);
});
