import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, writeJson } from "../server/core/files.mjs";
import { loadProfile } from "../server/core/profile.mjs";
import {
  buildPlan,
  applyPlan,
  verify,
  restorePlan,
  restore,
} from "../server/core/sync.mjs";

async function fixture(t, { installed = false, patch = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "paseo-sync-"));
  const root = path.join(base, "repo"),
    home = path.join(base, "home"),
    state = path.join(base, "state");
  await Promise.all(
    [root, home, state].map((x) => mkdir(x, { recursive: true })),
  );
  await writeJson(path.join(home, "config.json"), {
    pluginsEnabled: true,
    daemon: { secret: "not-exported" },
  });
  const plugin = {
    id: "better-paseo",
    source: "npm:better-paseo",
    revision: "1.0.0",
    enabled: true,
  };
  const manifest = {
    schemaVersion: 1,
    plugins: [plugin],
    settings: [
      {
        plugin: plugin.id,
        document: "presentation",
        file: "settings/better-paseo/presentation.json",
      },
    ],
    patches: [],
  };
  const target = { version: 1, values: { previewWrap: true } };
  await writeJson(path.join(root, manifest.settings[0].file), target);
  if (patch) {
    const before = 'icon="Github"',
      after = 'icon="GitPullRequest"';
    const data = {
      schemaVersion: 1,
      plugin: plugin.id,
      revision: "1.0.0",
      files: [
        {
          path: "index.client.tsx",
          beforeSha256: digest(before),
          afterSha256: digest(after),
          find: '"Github"',
          replace: '"GitPullRequest"',
          count: 1,
        },
      ],
    };
    manifest.patches = [{ plugin: plugin.id, file: "patches/icon.json" }];
    await writeJson(path.join(root, "patches/icon.json"), data);
  }
  await writeJson(path.join(root, "profile.json"), manifest);
  let rows = [];
  const calls = [];
  async function install(p) {
    if (rows.some((x) => x.id === p.id))
      throw new Error("Plugin ID already configured");
    calls.push(["install", p.id, p.revision]);
    const dir = path.join(home, "plugins", p.id, p.revision);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.client.tsx"), 'icon="Github"');
    rows = rows.filter((x) => x.id !== p.id);
    rows.push({
      id: p.id,
      path: dir,
      enabled: true,
      status: "running",
      installation: {
        identity: {
          kind: "npm",
          packageName: p.source.slice(4),
          pluginPath: ".",
        },
        currentRevision: p.revision,
      },
    });
  }
  const adapter = {
    async list() {
      return structuredClone(rows);
    },
    install,
    async update(p) {
      calls.push(["update", p.id, p.revision]);
      const old = rows.find((x) => x.id === p.id);
      assert.ok(old);
      const enabled = old.enabled;
      rows = rows.filter((x) => x.id !== p.id);
      await install(p);
      rows.find((x) => x.id === p.id).enabled = enabled;
      rows.find((x) => x.id === p.id).status = enabled ? "running" : "disabled";
    },
    async act(action, id) {
      calls.push([action, id]);
      const row = rows.find((x) => x.id === id);
      assert.ok(row);
      if (action === "disable") {
        row.enabled = false;
        row.status = "disabled";
      }
      if (action === "enable" || action === "reload") {
        row.enabled = true;
        row.status = "running";
      }
    },
  };
  if (installed) await install(plugin);
  calls.length = 0;
  const ctx = { root, home, state, adapter };
  return {
    ctx,
    calls,
    manifest,
    target,
    plugin,
    adapter,
    setting: path.join(home, "plugin-settings/better-paseo/presentation.json"),
    root,
    home,
    state,
  };
}

test("installs pinned plugin, applies patch and setting, then becomes idempotent", async (t) => {
  const f = await fixture(t, { patch: true });
  const plan = await buildPlan(f.ctx);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.conflicts.length, 0);
  const result = await applyPlan(f.ctx, plan.approval);
  assert.equal(result.verification.configurationMatches, true);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), f.target);
  const row = (await f.adapter.list())[0];
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    'icon="GitPullRequest"',
  );
  f.calls.length = 0;
  const again = await buildPlan(f.ctx);
  assert.equal(again.changes.length, 0);
  await applyPlan(f.ctx, again.approval);
  assert.deepEqual(f.calls, []);
});

test("rejects stale plan when target settings change after preview", async (t) => {
  const f = await fixture(t, { installed: true });
  const p = await buildPlan(f.ctx);
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: false },
  });
  await assert.rejects(applyPlan(f.ctx, p.approval), /stale/i);
  assert.deepEqual(f.calls, []);
});

test("rejects disabled global switch and refuses to turn it on", async (t) => {
  const f = await fixture(t);
  await writeJson(path.join(f.home, "config.json"), { pluginsEnabled: false });
  const p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => x.includes("pluginsEnabled")));
  await assert.rejects(applyPlan(f.ctx, p.approval));
  assert.deepEqual(f.calls, []);
});

test("detects local edits against baseline and supports an explicit profile preference", async (t) => {
  const f = await fixture(t, { installed: true });
  let p = await buildPlan(f.ctx);
  await applyPlan(f.ctx, p.approval);
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: true, previewStripes: true },
  });
  p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.length);
  await assert.rejects(applyPlan(f.ctx, p.approval));
  p = await buildPlan({ ...f.ctx, preferProfile: true });
  assert.equal(p.conflicts.length, 0);
  await applyPlan({ ...f.ctx, preferProfile: true }, p.approval);
  assert.equal((await verify(f.ctx)).configurationMatches, true);
});

test("detects concurrent settings write while stopping the plugin", async (t) => {
  const f = await fixture(t, { installed: true });
  const old = f.adapter.act;
  f.adapter.act = async (action, id) => {
    await old(action, id);
    if (action === "disable")
      await writeJson(f.setting, {
        version: 1,
        values: { previewStripes: false },
      });
  };
  const p = await buildPlan(f.ctx);
  await assert.rejects(applyPlan(f.ctx, p.approval), /changed|concurrent/i);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewStripes: false,
  });
});

test("backs up originals before writing and restores settings and enabled state", async (t) => {
  const f = await fixture(t, { installed: true, patch: true });
  const original = { version: 1, values: { previewWrap: false } };
  await writeJson(f.setting, original);
  const plan = await buildPlan(f.ctx);
  const result = await applyPlan(f.ctx, plan.approval);
  const preview = await restorePlan(f.ctx, result.backupId);
  assert.ok(preview.approval);
  await restore(f.ctx, result.backupId, preview.approval);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), original);
  const row = (await f.adapter.list())[0];
  assert.equal(row.enabled, true);
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    'icon="Github"',
  );
});

test("unknown patch bytes fail during planning without mutating plugin", async (t) => {
  const f = await fixture(t, { installed: true, patch: true });
  const row = (await f.adapter.list())[0];
  await writeFile(path.join(row.path, "index.client.tsx"), "unexpected edit");
  await assert.rejects(buildPlan(f.ctx), /changed/i);
  assert.deepEqual(f.calls, []);
});

test("partial install failure returns a backup identifier and preserves error status", async (t) => {
  const f = await fixture(t);
  const p = await buildPlan(f.ctx);
  f.adapter.install = async () => {
    throw new Error("simulated install failure");
  };
  await assert.rejects(
    applyPlan(f.ctx, p.approval),
    (e) => !!e.backupId && e.message.includes("simulated install failure"),
  );
});

test("verify distinguishes matching files from failed runtime state", async (t) => {
  const f = await fixture(t, { installed: true });
  const p = await buildPlan(f.ctx);
  await applyPlan(f.ctx, p.approval);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].status = "failed";
    return rows;
  };
  const v = await verify(f.ctx);
  assert.equal(v.configurationMatches, true);
  assert.equal(v.runtimeHealthy, false);
});

test("restore retains a newly installed plugin disabled and restores pre-existing orphan settings", async (t) => {
  const f = await fixture(t);
  const orphan = { version: 1, values: { previewWrap: false } };
  await writeJson(f.setting, orphan);
  const p = await buildPlan(f.ctx);
  const result = await applyPlan(f.ctx, p.approval);
  const preview = await restorePlan(f.ctx, result.backupId);
  const restored = await restore(f.ctx, result.backupId, preview.approval);
  assert.deepEqual(restored.retainedDisabledPlugins, ["better-paseo"]);
  assert.equal((await f.adapter.list())[0].enabled, false);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), orphan);
});

test("restore preserves concurrent settings saved while stopping the plugin", async (t) => {
  const f = await fixture(t, { installed: true });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const p = await buildPlan(f.ctx),
    result = await applyPlan(f.ctx, p.approval);
  const preview = await restorePlan(f.ctx, result.backupId);
  const originalAct = f.adapter.act,
    concurrent = {
      version: 1,
      values: { previewWrap: true, previewStripes: true },
    };
  f.adapter.act = async (action, id) => {
    await originalAct(action, id);
    if (action === "disable") await writeJson(f.setting, concurrent);
  };
  await assert.rejects(
    restore(f.ctx, result.backupId, preview.approval),
    /concurrent|changed/i,
  );
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), concurrent);
});

test("does not install a disabled target because Paseo install starts plugins immediately", async (t) => {
  const f = await fixture(t);
  f.manifest.plugins[0].enabled = false;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => x.includes("disabled")));
  await assert.rejects(applyPlan(f.ctx, p.approval));
  assert.deepEqual(f.calls, []);
});

test("updates installed npm versions in both directions and restores a previously disabled version", async (t) => {
  const f = await fixture(t, { installed: true });
  await f.adapter.act("disable", "better-paseo");
  f.manifest.plugins[0].revision = "2.0.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  let p = await buildPlan(f.ctx);
  assert.ok(p.changes[0].actions.includes("update"));
  const result = await applyPlan(f.ctx, p.approval);
  assert.ok(f.calls.some((x) => x[0] === "update" && x[2] === "2.0.0"));
  const preview = await restorePlan(f.ctx, result.backupId);
  assert.equal(preview.conflicts.length, 0);
  await restore(f.ctx, result.backupId, preview.approval);
  const row = (await f.adapter.list())[0];
  assert.equal(row.installation.currentRevision, "1.0.0");
  assert.equal(row.enabled, false);
});

test("blocks source changes and self management before mutation", async (t) => {
  const f = await fixture(t, { installed: true });
  f.manifest.plugins[0].source = "npm:other";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  let p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => /source/i.test(x)));
  await assert.rejects(applyPlan(f.ctx, p.approval));
  assert.deepEqual(f.calls, []);
  f.manifest.plugins = [
    {
      id: "paseo-sync",
      source: "npm:paseo-sync",
      revision: "0.1.0",
      enabled: true,
    },
  ];
  f.manifest.settings = [];
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => /self/i.test(x)));
});

test("registry version transitions fail visibly before stopping the plugin", async (t) => {
  const f = await fixture(t, { installed: true }),
    list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation.identity.registry = {
      url: "https://plugins.paseo.sh",
      id: "example/demo",
    };
    return rows;
  };
  f.manifest.plugins[0].revision = "2.0.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => /registry/i.test(x)));
  await assert.rejects(applyPlan(f.ctx, p.approval));
  assert.deepEqual(f.calls, []);
});
test("an interrupted backup without an observed final state cannot be blindly restored", async (t) => {
  const f = await fixture(t, { installed: true });
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval);
  const file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  b.status = "pending";
  b.after = null;
  await writeJson(file, b);
  const restore = await restorePlan(f.ctx, r.backupId);
  assert.ok(restore.conflicts.some((x) => /interrupt|inspect/i.test(x)));
});
test("preview includes current and target versions and setting values for review", async (t) => {
  const f = await fixture(t, { installed: true });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  f.manifest.plugins[0].revision = "2.0.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx);
  assert.equal(p.changes[0].from.revision, "1.0.0");
  assert.equal(p.changes[0].to.revision, "2.0.0");
  assert.equal(p.changes[0].settings[0].before.values.previewWrap, false);
  assert.equal(p.changes[0].settings[0].after.values.previewWrap, true);
});

test("restore failures persist final observed state and backup ID, permitting a reviewed retry", async (t) => {
  const f = await fixture(t, { installed: true });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const applied = await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval),
    p = await restorePlan(f.ctx, applied.backupId),
    act = f.adapter.act;
  f.adapter.act = async (a, id) => {
    if (a === "enable") throw new Error("restore enable failure");
    return act(a, id);
  };
  await assert.rejects(
    restore(f.ctx, applied.backupId, p.approval),
    (e) => e.backupId === applied.backupId,
  );
  const b = JSON.parse(
    await readFile(
      path.join(f.state, "backups", applied.backupId + ".json"),
      "utf8",
    ),
  );
  assert.equal(b.status, "restore-failed");
  assert.ok(b.error);
  f.adapter.act = act;
  const next = await restorePlan(f.ctx, applied.backupId);
  assert.equal(next.currentChangedSinceBackup, false);
  await restore(f.ctx, applied.backupId, next.approval);
  assert.equal((await f.adapter.list())[0].enabled, true);
});

test("unrecorded Git source edits block update and fail configuration verification", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process");
  const row = (await f.adapter.list())[0];
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", row.path, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD");
  f.manifest.plugins[0].source = "git:https://github.com/example/demo";
  f.manifest.plugins[0].revision = sha;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha,
    };
    return rows;
  };
  await writeJson(f.setting, f.target);
  await writeFile(path.join(row.path, "index.client.tsx"), "local work");
  assert.equal((await verify(f.ctx)).configurationMatches, false);
  f.manifest.plugins[0].revision = "a".repeat(40);
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx);
  assert.ok(
    p.conflicts.some((x) => /source.*(edit|dirty)|local.*source/i.test(x)),
  );
  await assert.rejects(applyPlan(f.ctx, p.approval), /source/i);
  assert.deepEqual(f.calls, []);
});
test("legacy schema v1 backups without Git source metadata remain restorable when source is clean", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process"),
    row = (await f.adapter.list())[0];
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", row.path, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD");
  f.manifest.plugins[0].source = "git:https://github.com/example/demo";
  f.manifest.plugins[0].revision = sha;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha,
    };
    return rows;
  };
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval),
    file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  for (const state of [b.before, b.after])
    for (const plugin of Object.values(state.plugins))
      if (plugin) delete plugin.sourceState;
  await writeJson(file, b);
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.equal(preview.currentChangedSinceBackup, false);
  await restore(f.ctx, r.backupId, preview.approval);
});
