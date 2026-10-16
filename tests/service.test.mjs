import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as service from "../server/service.mjs";
import { writeJson } from "../server/core/files.mjs";
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "paseo-service-")),
    home = path.join(base, "home"),
    root = path.join(base, "profile");
  await mkdir(home);
  await mkdir(root);
  await writeJson(path.join(home, "config.json"), { pluginsEnabled: true });
  await writeJson(path.join(root, "profile.json"), {
    schemaVersion: 1,
    plugins: [],
    settings: [],
    patches: [],
  });
  const git = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...a], {
      stdio: "pipe",
    });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "init");
  const settings = {
      checkout: root,
      daemonHome: home,
      repositoryUrl: "",
      cliPath: "",
    },
    rows = [{ id: "paseo-sync", path: base, enabled: true, status: "running" }];
  const adapter = {
    status: async () => ({ pid: 123, daemonVersion: "0.11.4" }),
    list: async () => rows,
  };
  return {
    settings,
    adapter,
    stateRoot: path.join(base, "state"),
    readSettings: async () => settings,
    expectedPid: 123,
    adapterFactory: async () => adapter,
  };
}
async function done(s, j) {
  for (let i = 0; i < 200; i++) {
    const v = await s.getJob(j.id);
    if (v && ["failed", "succeeded"].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
}
test("service excludes its directory installation from portable export and binds execution to daemon PID", async () => {
  assert.equal(typeof service.createService, "function");
  const f = await fixture();
  const s = service.createService(f);
  const j = await s.start({ kind: "publishPlan" });
  const result = await done(s, j);
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.files.length, 0);
  f.adapter.status = async () => ({ pid: 999, daemonVersion: "0.11.4" });
  await assert.rejects(s.start({ kind: "plan" }), /daemon|PID/i);
});
test("service refuses stale plan and never applies without approval", async () => {
  const f = await fixture(),
    s = service.createService(f);
  const p = await done(s, await s.start({ kind: "plan" }));
  assert.equal(p.result.confirmKind, "apply");
  await assert.rejects(s.start({ kind: "apply" }), /approval/i);
  const result = await done(
    s,
    await s.start({ kind: "apply", approval: "stale" }),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error, /stale/i);
});
test("polling an existing job reuses the validated connection instead of spawning CLI each second", async () => {
  const f = await fixture();
  let calls = 0;
  f.adapter.status = async () => {
    calls++;
    return { pid: 123, daemonVersion: "0.11.4" };
  };
  const s = service.createService(f);
  const job = await s.start({ kind: "plan" });
  await done(s, job);
  await s.getJob(job.id);
  await s.getJob(job.id);
  assert.equal(calls, 1);
});
