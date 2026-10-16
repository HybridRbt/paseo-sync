import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as jobs from "../server/jobs.mjs";
const wait = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v.status !== "running" && v.status !== "queued") return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Job did not finish");
};
test("jobs persist progress, refuse concurrent work, and expose final results", async () => {
  assert.equal(typeof jobs.JobManager, "function");
  const state = await mkdtemp(path.join(tmpdir(), "paseo-jobs-"));
  const a = new jobs.JobManager(state),
    b = new jobs.JobManager(state);
  await a.initialize();
  let release;
  const gate = new Promise((r) => (release = r));
  const j = await a.start("apply", async (phase) => {
    await phase("backup");
    await gate;
    return { backupId: "example" };
  });
  await assert.rejects(
    b.start("publish", async () => ({})),
    /operation|active/i,
  );
  release();
  const result = await wait(() => a.get(j.id));
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.backupId, "example");
  const again = new jobs.JobManager(state);
  await again.initialize();
  assert.equal((await again.get(j.id)).status, "succeeded");
});
test("jobs retain errors and backup identifiers instead of reporting success", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "paseo-jobs-"));
  const m = new jobs.JobManager(state);
  await m.initialize();
  const j = await m.start("apply", async () => {
    const e = new Error("failed");
    e.backupId = "keep";
    throw e;
  });
  const result = await wait(() => m.get(j.id));
  assert.equal(result.status, "failed");
  assert.equal(result.backupId, "keep");
});
test("restart marks dead-owner jobs interrupted and unlocking never removes a live lock", async () => {
  const { writeJson } = await import("../server/core/files.mjs");
  const state = await mkdtemp(path.join(tmpdir(), "paseo-jobs-")),
    id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await writeJson(path.join(state, "jobs", id + ".json"), {
    id,
    status: "running",
  });
  await writeJson(path.join(state, "job.lock/owner.json"), {
    id,
    pid: 2147483647,
  });
  const m = new jobs.JobManager(state);
  await m.initialize();
  assert.equal((await m.get(id)).status, "interrupted");
  await m.unlock();
  await m.start("probe", async () => new Promise(() => {}));
  await assert.rejects(m.unlock(), /alive/i);
});
