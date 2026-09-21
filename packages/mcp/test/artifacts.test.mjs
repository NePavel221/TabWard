import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { saveQaScreenshots } from "../dist/artifacts.js";

test("parallel default QA screenshots use unique session/run names and exclusive writes", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-artifacts-"));
  const oldStateDir = process.env.TABWARD_STATE_DIR;
  process.env.TABWARD_STATE_DIR = stateDir;
  try {
    const results = Array.from({ length: 6 }, () => ({
      screenshots: [{
        data: Buffer.from("synthetic png bytes").toString("base64"),
        name: "https://secret.example/account?token=private"
      }]
    }));
    await Promise.all(results.map((result) =>
      saveQaScreenshots(result, [{}], "session-safe_123")
    ));
    const paths = results.map((result) => result.screenshots[0].artifact.path);
    assert.equal(new Set(paths).size, paths.length);
    for (const path of paths) {
      await access(path);
      const name = basename(path);
      assert.match(name, /^qa-session-safe_123-[a-f0-9-]{36}-1\.png$/);
      assert.doesNotMatch(name, /secret|example|account|token|private/i);
    }
    assert.equal(results.every((result) => !("data" in result.screenshots[0])), true);
  } finally {
    if (oldStateDir === undefined) delete process.env.TABWARD_STATE_DIR;
    else process.env.TABWARD_STATE_DIR = oldStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("fixed artifact names retain exclusive-create collision protection", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "tabward-artifact-fixed-"));
  const oldStateDir = process.env.TABWARD_STATE_DIR;
  process.env.TABWARD_STATE_DIR = stateDir;
  try {
    const make = () => ({
      screenshots: [{ data: Buffer.from("png").toString("base64") }]
    });
    await saveQaScreenshots(make(), [{ name: "caller-name" }], "session-a");
    await assert.rejects(
      saveQaScreenshots(make(), [{ name: "caller-name" }], "session-b"),
      (error) => error?.code === "EEXIST"
    );
  } finally {
    if (oldStateDir === undefined) delete process.env.TABWARD_STATE_DIR;
    else process.env.TABWARD_STATE_DIR = oldStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});
