import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const v = await s.getJob(j.id);
    if (v && ["failed", "succeeded"].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 20));
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
  assert.equal(p.status, "succeeded", p.error);
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

test("discovery reads saved repository without a working CLI and remembers successful repositories", async () => {
  const f = { ...(await fixture()), discoveryRoots: [] },
    s = service.createService(f);
  const first = await s.discover({});
  assert.equal(
    first.selected.checkout,
    await (await import("node:fs/promises")).realpath(f.settings.checkout),
  );
  await done(s, await s.start({ kind: "plan" }));
  const root = first.selected.checkout;
  f.settings.checkout = "";
  f.adapter.status = async () => {
    throw new Error("CLI unavailable");
  };
  const found = await s.discover({});
  assert.ok(found.candidates.some((c) => c.checkout === root));
});

test("service.openCheckout dispatches shortcut open to openShortcut handler", async () => {
  const f = await fixture();
  const opened = [];
  const s = service.createService({
    ...f,
    openShortcutOptions: {
      platform: "darwin",
      exec: (cmd, args, opts, cb) => {
        opened.push({ cmd, args });
        cb(null);
      },
    },
  });
  const res = await s.openCheckout({
    path: f.settings.checkout,
    target: "terminal",
  });
  assert.deepEqual(res, { status: "opened" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].cmd, "/usr/bin/open");
  assert.deepEqual(opened[0].args, ["-a", "Terminal", f.settings.checkout]);
});

test("service.openCheckout dispatches shortcut open to openShortcut handler with spawn", async () => {
  const f = await fixture();
  const spawned = [];
  const s = service.createService({
    ...f,
    openShortcutOptions: {
      platform: "linux",
      env: { TERMINAL: "xterm" },
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        const child = new EventEmitter();
        child.unref = () => {};
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
    },
  });
  const res = await s.openCheckout({
    path: f.settings.checkout,
    target: "terminal",
  });
  assert.deepEqual(res, { status: "opened" });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "xterm");
  assert.deepEqual(spawned[0].args, []);
  assert.equal(spawned[0].opts.cwd, f.settings.checkout);
});

test("service threads preferProfile and preferLocal through preview and execution and binds approvals", async () => {
  const f = await fixture();
  const s = service.createService(f);

  const p1 = await done(s, await s.start({ kind: "plan", preferProfile: true }));
  assert.equal(p1.status, "succeeded", p1.error);
  assert.equal(p1.result.preferProfile, true);
  // Mismatched preferProfile flag must reject as stale
  const mismatchApply = await done(
    s,
    await s.start({ kind: "apply", approval: p1.result.approval }),
  );
  assert.equal(mismatchApply.status, "failed");
  assert.match(mismatchApply.error, /stale/i);
  const okApply = await done(
    s,
    await s.start({
      kind: "apply",
      approval: p1.result.approval,
      preferProfile: true,
    }),
  );
  assert.equal(okApply.status, "succeeded", okApply.error);

  const pub1 = await done(
    s,
    await s.start({ kind: "publishPlan", preferLocal: true }),
  );
  assert.equal(pub1.status, "succeeded", pub1.error);
  assert.equal(pub1.result.preferLocal, true);
  const mismatchPub = await done(
    s,
    await s.start({ kind: "publish", approval: pub1.result.approval }),
  );
  assert.equal(mismatchPub.status, "failed");
  assert.match(mismatchPub.error, /stale/i);
});

