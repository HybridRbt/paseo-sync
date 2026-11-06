import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, writeJson } from "../server/core/files.mjs";
import { packPluginDirectory } from "../server/core/bundle.mjs";
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
    const isDir = path.isAbsolute(p.source);
    const dir = isDir ? p.source : path.join(home, "plugins", p.id, p.revision);
    if (!isDir) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.client.tsx"), 'icon="Github"');
    }
    rows = rows.filter((x) => x.id !== p.id);
    rows.push({
      id: p.id,
      path: dir,
      enabled: true,
      status: "running",
      installation: isDir
        ? {
            identity: {
              kind: "directory",
              path: dir,
            },
          }
        : {
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

test("skips an absent disabled target including its settings and patch, and verifies as synchronized", async (t) => {
  const f = await fixture(t, { patch: true });
  f.plugin.enabled = false;
  const orphan = { version: 1, values: { previewWrap: false } };
  await writeJson(f.setting, orphan);
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const plan = await buildPlan(f.ctx);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.skipped, [
    { plugin: "better-paseo", reason: "missing-disabled" },
  ]);
  const result = await applyPlan(f.ctx, plan.approval);
  assert.equal(result.changed, false);
  assert.equal(result.verification.configurationMatches, true);
  assert.equal(result.verification.runtimeHealthy, true);
  assert.deepEqual(f.calls, []);
  assert.equal((await buildPlan(f.ctx)).changes.length, 0);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), orphan);
});

test("skips missing disabled firstmate while installing other targets, then verifies and restores", async (t) => {
  const f = await fixture(t);
  f.manifest.plugins.push({
    id: "firstmate",
    source: "npm:@gpambrozio/paseo-firstmate",
    revision: "0.4.0",
    enabled: false,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const plan = await buildPlan(f.ctx);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.changes.map((c) => c.plugin),
    ["better-paseo"],
  );
  assert.deepEqual(plan.skipped, [
    { plugin: "firstmate", reason: "missing-disabled" },
  ]);
  const applied = await applyPlan(f.ctx, plan.approval);
  assert.equal(applied.verification.configurationMatches, true);
  assert.ok(!f.calls.some((c) => c[1] === "firstmate"));
  assert.equal((await verify(f.ctx)).runtimeHealthy, true);
  const undo = await restorePlan(f.ctx, applied.backupId);
  assert.deepEqual(undo.conflicts, []);
  await restore(f.ctx, applied.backupId, undo.approval);
  assert.ok(!f.calls.some((c) => c[1] === "firstmate"));
});

test("a plugin appearing after skip preview invalidates its approval", async (t) => {
  const f = await fixture(t);
  f.plugin.enabled = false;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx);
  await f.adapter.install(f.plugin);
  f.calls.length = 0;
  await assert.rejects(applyPlan(f.ctx, p.approval), /stale/i);
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

test("unrecorded Git source edits skip the plugin with disclosed files instead of blocking", async (t) => {
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
  // Standalone verification keeps reporting the drift honestly.
  assert.equal((await verify(f.ctx)).configurationMatches, false);
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["index.client.tsx"],
      checkout: row.path,
    },
  ]);
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.changed, false);
  assert.equal(result.verification.configurationMatches, true);
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    "local work",
  );
  assert.deepEqual(f.calls, []);
  // Converging back to a clean source invalidates the dirty preview.
  await writeFile(path.join(row.path, "index.client.tsx"), 'icon="Github"');
  const clean = await buildPlan(f.ctx);
  assert.deepEqual(clean.skipped, []);
  await assert.rejects(applyPlan(f.ctx, p.approval), /stale/i);
  await applyPlan(f.ctx, clean.approval);
  assert.equal((await verify(f.ctx)).configurationMatches, true);
});
test("a dirty Git plugin is skipped while other targets still apply", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process");
  f.manifest.plugins.push({
    id: "firstmate",
    source: "npm:@gpambrozio/paseo-firstmate",
    revision: "0.4.0",
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
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
    rows.find((x) => x.id === "better-paseo").installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha,
    };
    return rows;
  };
  await writeFile(path.join(row.path, "extra.ts"), "local experiment");
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["extra.ts"],
      checkout: row.path,
    },
  ]);
  assert.deepEqual(
    p.changes.map((c) => ({ plugin: c.plugin, actions: c.actions })),
    [{ plugin: "firstmate", actions: ["install"] }],
  );
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.changed, true);
  assert.ok(f.calls.some((x) => x[0] === "install" && x[1] === "firstmate"));
  assert.ok(!f.calls.some((x) => x[1] === "better-paseo"));
  assert.equal(
    await readFile(path.join(row.path, "extra.ts"), "utf8"),
    "local experiment",
  );
  // The skipped plugin's pending settings write is not applied either.
  await assert.rejects(readFile(f.setting));
  assert.equal(result.verification.configurationMatches, true);
  assert.equal(
    (await f.adapter.list()).some((x) => x.id === "firstmate"),
    true,
  );
});
test("a Git HEAD drift skips as head-differs with the drifted revision disclosed", async (t) => {
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
  await writeFile(path.join(row.path, "index.client.tsx"), 'icon="Two"');
  git("commit", "-qam", "two");
  const drifted = git("rev-parse", "HEAD");
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.skipped, [
    {
      plugin: "better-paseo",
      reason: "head-differs",
      head: drifted,
      revision: sha,
      checkout: row.path,
    },
  ]);
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.changed, false);
  assert.deepEqual(f.calls, []);
});
test("a dirty skip-only apply preserves the previous baseline so local settings edits stay protected", async (t) => {
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
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  const edited = { version: 1, values: { previewWrap: false } };
  await writeJson(f.setting, edited);
  await writeFile(path.join(row.path, "index.client.tsx"), "local work");
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.skipped.map((s) => s.reason), ["local-source-changes"]);
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.changed, false);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), edited);
  const baseline = JSON.parse(
    await readFile(path.join(f.state, "baseline.json"), "utf8"),
  );
  assert.equal(baseline.plugins["better-paseo"].revision, sha);
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        baseline.settings[f.manifest.settings[0].file],
        "base64",
      ).toString("utf8"),
    ),
    f.target,
  );
  // Converging back to a clean source must re-expose the local settings edit
  // as a conflict instead of silently overwriting it.
  await writeFile(path.join(row.path, "index.client.tsx"), 'icon="Github"');
  const after = await buildPlan(f.ctx);
  assert.deepEqual(after.skipped, []);
  assert.ok(after.conflicts.some((x) => /local changes conflict/i.test(x)));
  await assert.rejects(applyPlan(f.ctx, after.approval));
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), edited);
});
test("a mixed apply preserves the dirty skipped plugin's previous baseline entries", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process");
  const firstmate = {
    id: "firstmate",
    source: "npm:firstmate",
    revision: "0.4.0",
    enabled: true,
  };
  f.manifest.plugins.push(firstmate);
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
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
    rows.find((x) => x.id === "better-paseo").installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha,
    };
    return rows;
  };
  await writeJson(f.setting, f.target);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  firstmate.revision = "0.5.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const edited = { version: 1, values: { previewWrap: false } };
  await writeJson(f.setting, edited);
  await writeFile(path.join(row.path, "extra.ts"), "local experiment");
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.skipped.map((s) => s.plugin), ["better-paseo"]);
  assert.deepEqual(
    p.changes.map((c) => c.plugin),
    ["firstmate"],
  );
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.changed, true);
  assert.equal(result.verification.configurationMatches, true);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), edited);
  // backup.after excludes the skipped plugin; its previous entries must be
  // merged back into the saved baseline.
  const baseline = JSON.parse(
    await readFile(path.join(f.state, "baseline.json"), "utf8"),
  );
  assert.equal(baseline.plugins["better-paseo"].revision, sha);
  assert.equal(baseline.plugins.firstmate.revision, "0.5.0");
  assert.deepEqual(
    JSON.parse(
      Buffer.from(
        baseline.settings[f.manifest.settings[0].file],
        "base64",
      ).toString("utf8"),
    ),
    f.target,
  );
  await rm(path.join(row.path, "extra.ts"));
  const after = await buildPlan(f.ctx);
  assert.deepEqual(after.skipped, []);
  assert.ok(after.conflicts.some((x) => /local changes conflict/i.test(x)));
});

test("a dirty Git plugin is skipped at restore with disclosed files and checkout", async (t) => {
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
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval),
    file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  // Simulate a backup written before source-state metadata existed: local
  // dirtiness then does not count as a post-operation change, so the dirty
  // checkout must be disclosed as a skip instead of dead-ending the restore.
  for (const state of [b.before, b.after])
    for (const plugin of Object.values(state.plugins))
      if (plugin) delete plugin.sourceState;
  await writeJson(file, b);
  f.calls.length = 0;
  await writeFile(path.join(row.path, "extra.ts"), "local experiment");
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.currentChangedSinceBackup, false);
  assert.deepEqual(preview.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["extra.ts"],
      checkout: row.path,
      restore: true,
    },
  ]);
  assert.deepEqual(preview.changes, []);
  // The client disclosure renders the files, checkout and repair guidance
  // in both languages from the actual skipped entry.
  const { translator } = await import("../client/i18n.mjs");
  const entry = preview.skipped[0],
    skipLine =
      "跳过 {plugin}：本地源码有未提交改动，本次恢复不改动该插件。",
    guidance =
      "该插件本次保持本机现状，未被恢复修改。完成本次恢复后，在插件源码仓库提交并推送，运行 paseo plugin update {plugin}，再重新预览恢复即可恢复备份中的版本。";
  for (const language of ["zh", "en"]) {
    const t = translator(language),
      rendered = [
        t(skipLine, { plugin: entry.plugin }),
        t("改动文件：{files}", { files: entry.files.join(", ") }),
        t("本机源码目录：{checkout}", { checkout: entry.checkout }),
        t(guidance, { plugin: entry.plugin }),
      ].join("\n");
    for (const expected of [
      entry.plugin,
      entry.files[0],
      entry.checkout,
      "paseo plugin update",
    ])
      assert.ok(rendered.includes(expected), `${language}: ${expected}`);
  }
  assert.notEqual(
    translator("en")(guidance, { plugin: entry.plugin }),
    guidance,
  );
  const restored = await restore(f.ctx, r.backupId, preview.approval);
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.retainedDisabledPlugins, []);
  assert.deepEqual(f.calls, []);
  assert.equal(
    await readFile(path.join(row.path, "extra.ts"), "utf8"),
    "local experiment",
  );
  // The skipped plugin's settings are not rolled back either.
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), f.target);
  assert.equal((await f.adapter.list())[0].enabled, true);
});
test("a drifted Git HEAD skips at restore as head-differs and keeps the local source", async (t) => {
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
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval),
    file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  for (const state of [b.before, b.after])
    for (const plugin of Object.values(state.plugins))
      if (plugin) delete plugin.sourceState;
  await writeJson(file, b);
  f.calls.length = 0;
  await writeFile(path.join(row.path, "index.client.tsx"), 'icon="Two"');
  git("commit", "-qam", "two");
  const drifted = git("rev-parse", "HEAD");
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.skipped, [
    {
      plugin: "better-paseo",
      reason: "head-differs",
      head: drifted,
      revision: sha,
      checkout: row.path,
      restore: true,
    },
  ]);
  const { translator } = await import("../client/i18n.mjs");
  const headLine =
    "跳过 {plugin}：本机源码与安装版本不一致，本次恢复不改动该插件。";
  assert.ok(
    translator("en")(headLine, { plugin: "better-paseo" }).includes(
      "better-paseo",
    ),
  );
  assert.notEqual(
    translator("en")(headLine, { plugin: "better-paseo" }),
    headLine,
  );
  await restore(f.ctx, r.backupId, preview.approval);
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    'icon="Two"',
  );
  assert.deepEqual(f.calls, []);
});
test("following the restore skip guidance recovers the plugin without tripping the snapshot guard", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process"),
    checkout = (await f.adapter.list())[0].path;
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", checkout, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD");
  const descriptor = {
    id: "better-paseo",
    source: "git:https://github.com/example/demo",
    revision: sha,
    enabled: true,
  };
  f.manifest.plugins[0].source = descriptor.source;
  f.manifest.plugins[0].revision = sha;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  // The daemon reports Git identity for the checkout regardless of which
  // revision-named directory the fake installer last created; revisions move
  // only through adapter.update, as they would through the real CLI.
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].path = checkout;
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: rows[0].installation.currentRevision,
    };
    return rows;
  };
  await f.adapter.update(descriptor);
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval),
    file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  // A legacy backup without source-state metadata: dirtiness is not a
  // post-operation change, so the first restore skips and discloses.
  for (const state of [b.before, b.after])
    for (const plugin of Object.values(state.plugins))
      if (plugin) delete plugin.sourceState;
  await writeJson(file, b);
  f.calls.length = 0;
  await writeFile(path.join(checkout, "extra.ts"), "local experiment");
  const first = await restorePlan(f.ctx, r.backupId);
  assert.equal(first.currentChangedSinceBackup, false);
  assert.equal(first.skipped.length, 1);
  const partial = await restore(f.ctx, r.backupId, first.approval);
  assert.equal(partial.restored, true);
  assert.deepEqual(f.calls, []);
  // The partial restore rewrote after with a source-aware snapshot recording
  // the dirty checkout. The user follows the guidance: commit, push, then
  // paseo plugin update resolves the checkout at a new revision.
  git("add", "extra.ts");
  git("commit", "-qm", "keep experiment");
  const resolved = git("rev-parse", "HEAD");
  await f.adapter.update({ ...descriptor, revision: resolved });
  f.calls.length = 0;
  const retry = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(retry.skipped, []);
  assert.equal(retry.currentChangedSinceBackup, false);
  const done = await restore(f.ctx, r.backupId, retry.approval);
  assert.equal(done.restored, true);
  assert.ok(
    f.calls.some((c) => c[0] === "update" && c[2] === sha),
    `expected a reinstall of the backed-up revision ${sha}: ${JSON.stringify(f.calls)}`,
  );
  await assert.rejects(readFile(f.setting));
});
test("a failed apply that captured a dirty source stays restorable after the checkout is resolved", async (t) => {
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
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval),
    file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  // The apply failed after the local source went dirty: its final capture
  // records the divergence in after.
  b.status = "failed";
  b.error = "simulated apply failure";
  b.after.plugins["better-paseo"].sourceState = {
    clean: false,
    head: sha,
    statusHash: "observed",
    changed: ["extra.ts"],
  };
  await writeJson(file, b);
  f.calls.length = 0;
  await writeFile(path.join(row.path, "extra.ts"), "local experiment");
  const first = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.currentChangedSinceBackup, false);
  assert.deepEqual(first.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["extra.ts"],
      checkout: row.path,
      restore: true,
    },
  ]);
  // Resolving by discarding the edits must not invalidate the backup either.
  git("clean", "-fq", "--", "extra.ts");
  const retry = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(retry.skipped, []);
  assert.equal(retry.currentChangedSinceBackup, false);
  await restore(f.ctx, r.backupId, retry.approval);
  assert.deepEqual(f.calls, [
    ["disable", "better-paseo"],
    ["enable", "better-paseo"],
  ]);
  await assert.rejects(readFile(f.setting));
});
test("restore still refuses when unrelated managed data changed after the operation", async (t) => {
  const f = await fixture(t, { installed: true });
  const r = await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.ok(preview.currentChangedSinceBackup);
  assert.deepEqual(preview.currentChangedSinceBackup.settings, [
    "settings/better-paseo/presentation.json",
  ]);
  const { canConfirmPreview, translator, renderDriftDisclosure } =
    await import("../client/i18n.mjs");
  assert.equal(canConfirmPreview({ ...preview, confirmKind: "restore" }), false);
  for (const language of ["zh", "en"]) {
    const tLang = translator(language);
    const rendered = renderDriftDisclosure(preview.currentChangedSinceBackup, tLang).join("\n");
    assert.ok(rendered.includes("settings/better-paseo/presentation.json"));
  }
  await assert.rejects(
    restore(f.ctx, r.backupId, preview.approval),
    /changed after the operation; resolve those changes before restoring. \(settings: settings\/better-paseo\/presentation.json\)/,
  );
});
test("local edits to a managed patch file of a dirty Git plugin do not block the restore", async (t) => {
  const f = await fixture(t, { installed: true, patch: true }),
    { execFileSync } = await import("node:child_process"),
    { realpath } = await import("node:fs/promises");
  const row = (await f.adapter.list())[0];
  // sourceState matches patch files by name relative to git's toplevel, so
  // the reported path must be the canonical one (/private/var on macOS); the
  // home goes with it so installedFile's containment check still holds.
  const checkout = await realpath(row.path);
  f.ctx.home = await realpath(f.ctx.home);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", checkout, ...args],
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
  const bundle = JSON.parse(
    await readFile(path.join(f.root, f.manifest.patches[0].file), "utf8"),
  );
  bundle.revision = sha;
  await writeJson(path.join(f.root, f.manifest.patches[0].file), bundle);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].path = checkout;
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha,
    };
    return rows;
  };
  // The apply installs the managed patch; the patched state itself stays
  // clean because sourceState treats the patch's after-bytes as allowed.
  const r = await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    'icon="GitPullRequest"',
  );
  f.calls.length = 0;
  // Editing the patch target dirties the checkout; the captured patch bytes
  // are those same local source files, so the disclosed skip must keep them
  // out of the snapshot guard instead of blocking the whole restore.
  await writeFile(path.join(checkout, "index.client.tsx"), 'icon="Two"');
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(preview.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["index.client.tsx"],
      checkout,
      restore: true,
    },
  ]);
  assert.equal(preview.currentChangedSinceBackup, false);
  const restored = await restore(f.ctx, r.backupId, preview.approval);
  assert.equal(restored.restored, true);
  assert.deepEqual(f.calls, []);
  assert.equal(
    await readFile(path.join(checkout, "index.client.tsx"), "utf8"),
    'icon="Two"',
  );
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), f.target);
});
test("unrelated managed data drift alongside a dirty Git plugin discloses drift and disables confirm while preserving skip disclosure", async (t) => {
  const f = await fixture(t, { installed: true }),
    { execFileSync } = await import("node:child_process"),
    checkout = (await f.adapter.list())[0].path;
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", checkout, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD");
  const descriptor = {
    id: "better-paseo",
    source: "git:https://github.com/example/demo",
    revision: sha,
    enabled: true,
  };
  f.manifest.plugins[0].source = descriptor.source;
  f.manifest.plugins[0].revision = sha;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].path = checkout;
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: rows[0].installation.currentRevision,
    };
    return rows;
  };
  await f.adapter.update(descriptor);
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval);
  f.calls.length = 0;

  // Dirty the Git plugin AND change settings concurrently after the backup
  await writeFile(path.join(checkout, "extra.ts"), "local experiment");
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });

  const preview = await restorePlan(f.ctx, r.backupId);
  // Dirty git plugin is skipped
  assert.deepEqual(preview.skipped, [
    {
      plugin: "better-paseo",
      reason: "local-source-changes",
      files: ["extra.ts"],
      checkout,
      restore: true,
    },
  ]);
  // Settings drift trips currentChangedSinceBackup
  assert.ok(preview.currentChangedSinceBackup);
  assert.deepEqual(preview.currentChangedSinceBackup.settings, [
    "settings/better-paseo/presentation.json",
  ]);

  const { translator, canConfirmPreview, renderDriftDisclosure } =
    await import("../client/i18n.mjs");
  const clientPreview = { ...preview, confirmKind: "restore" };
  assert.equal(canConfirmPreview(clientPreview), false);

  for (const language of ["zh", "en"]) {
    const tLang = translator(language);
    const rendered = renderDriftDisclosure(preview.currentChangedSinceBackup, tLang).join("\n");
    assert.ok(rendered.includes("settings/better-paseo/presentation.json"));
  }

  // Restore rejected due to settings drift
  await assert.rejects(
    restore(f.ctx, r.backupId, preview.approval),
    /Current managed data changed after the operation; resolve those changes before restoring\. \(settings: settings\/better-paseo\/presentation\.json\)/,
  );

  // Restore the setting to align with the backup, keeping git checkout dirty
  await writeJson(f.setting, f.target);
  const retry = await restorePlan(f.ctx, r.backupId);
  assert.equal(retry.currentChangedSinceBackup, false);
  assert.equal(canConfirmPreview({ ...retry, confirmKind: "restore" }), true);
  const restored = await restore(f.ctx, r.backupId, retry.approval);
  assert.equal(restored.restored, true);
  // Git checkout was skipped and untouched
  assert.equal(
    await readFile(path.join(checkout, "extra.ts"), "utf8"),
    "local experiment",
  );
});
test("a modified patch after backup discloses patch drift and disables confirm", async (t) => {
  const f = await fixture(t, { installed: true, patch: true });
  const row = (await f.adapter.list())[0];
  const plan = await buildPlan(f.ctx);
  const result = await applyPlan(f.ctx, plan.approval);

  // Edit the patched file after the backup
  await writeFile(
    path.join(row.path, "index.client.tsx"),
    'icon="ExternalDrift"',
  );

  const preview = await restorePlan(f.ctx, result.backupId);
  assert.ok(preview.currentChangedSinceBackup);
  assert.deepEqual(preview.currentChangedSinceBackup.patches, [
    "better-paseo/index.client.tsx",
  ]);

  const { translator, canConfirmPreview, renderDriftDisclosure } =
    await import("../client/i18n.mjs");
  const clientPreview = { ...preview, confirmKind: "restore" };
  assert.equal(canConfirmPreview(clientPreview), false);

  for (const language of ["zh", "en"]) {
    const tLang = translator(language),
      lines = renderDriftDisclosure(preview.currentChangedSinceBackup, tLang),
      rendered = lines.join("\n");
    assert.ok(
      rendered.includes("better-paseo/index.client.tsx"),
      `${language}: missing patch key`,
    );
    if (language === "en") {
      assert.ok(
        rendered.includes("Patches changed after the backup:"),
        "en: missing label",
      );
    } else {
      assert.ok(
        rendered.includes("补丁在备份后发生变化："),
        "zh: missing label",
      );
    }
  }

  await assert.rejects(
    restore(f.ctx, result.backupId, preview.approval),
    /patches: better-paseo\/index\.client\.tsx/,
  );
});
test("a clean Git revision update after backup is disclosed as plugin drift rather than HEAD mismatch", async (t) => {
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
  const sha1 = git("rev-parse", "HEAD");
  f.manifest.plugins[0].source = "git:https://github.com/example/demo";
  f.manifest.plugins[0].revision = sha1;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha1,
    };
    return rows;
  };
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval);

  // Legitimate update: new commit committed, checkout clean, installed revision updated
  await writeFile(path.join(row.path, "index.client.tsx"), 'icon="V2"');
  git("commit", "-qam", "v2");
  const sha2 = git("rev-parse", "HEAD");
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {
      identity: { kind: "git", remote: "https://github.com/example/demo" },
      currentRevision: sha2,
    };
    return rows;
  };

  const preview = await restorePlan(f.ctx, r.backupId);
  assert.ok(preview.currentChangedSinceBackup);
  // Source checkout is clean and matches installed revision, so source drift is empty
  assert.deepEqual(preview.currentChangedSinceBackup.source, []);
  // Tracked solely as plugin configuration change
  assert.ok(
    preview.currentChangedSinceBackup.plugins.some(
      (p) => p.plugin === "better-paseo",
    ),
  );

  const { translator, canConfirmPreview, renderDriftDisclosure } =
    await import("../client/i18n.mjs");
  assert.equal(canConfirmPreview({ ...preview, confirmKind: "restore" }), false);

  for (const language of ["zh", "en"]) {
    const tLang = translator(language),
      lines = renderDriftDisclosure(preview.currentChangedSinceBackup, tLang),
      rendered = lines.join("\n");
    assert.ok(rendered.includes("better-paseo"), `${language}: better-paseo`);
    // Crucial: must NOT falsely report that local HEAD differs from installed revision
    assert.ok(!rendered.includes("head differs") && !rendered.includes("HEAD differs"));
    assert.ok(!rendered.includes("本机源码与安装版本不一致"));
  }
});
test("a changed global pluginsEnabled switch after backup discloses drift and disables confirm", async (t) => {
  const f = await fixture(t, { installed: true });
  const p = await buildPlan(f.ctx);
  const r = await applyPlan(f.ctx, p.approval);

  // Toggle global plugin switch in config.json after the backup
  await writeJson(path.join(f.home, "config.json"), { pluginsEnabled: false });

  const preview = await restorePlan(f.ctx, r.backupId);
  assert.ok(preview.currentChangedSinceBackup);
  assert.deepEqual(preview.currentChangedSinceBackup.pluginsEnabled, {
    from: true,
    to: false,
  });

  const { translator, canConfirmPreview, renderDriftDisclosure } =
    await import("../client/i18n.mjs");
  assert.equal(canConfirmPreview({ ...preview, confirmKind: "restore" }), false);

  for (const language of ["zh", "en"]) {
    const tLang = translator(language);
    const lines = renderDriftDisclosure(preview.currentChangedSinceBackup, tLang);
    const rendered = lines.join("\n");
    assert.ok(
      rendered.includes("true -> false"),
      `${language}: missing switch values`,
    );
    if (language === "en") {
      assert.ok(
        rendered.includes("Global plugin switch changed after the backup:"),
        "en: missing label",
      );
    } else {
      assert.ok(
        rendered.includes("全局插件开关在备份后发生变化："),
        "zh: missing label",
      );
    }
  }

  await assert.rejects(
    restore(f.ctx, r.backupId, preview.approval),
    /pluginsEnabled: true -> false/,
  );
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

test("already installed disabled targets still update without enabling them", async (t) => {
  const f = await fixture(t, { installed: true });
  await f.adapter.act("disable", f.plugin.id);
  f.plugin.enabled = false;
  f.plugin.revision = "2.0.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  f.calls.length = 0;
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.skipped, []);
  assert.ok(p.changes[0].actions.includes("update"));
  await applyPlan(f.ctx, p.approval);
  const row = (await f.adapter.list())[0];
  assert.equal(row.enabled, false);
  assert.equal(row.installation.currentRevision, "2.0.0");
  assert.ok(!f.calls.some((c) => c[0] === "enable"));
});

test("restore still refuses reinstalling a previously installed disabled plugin that disappeared", async (t) => {
  const f = await fixture(t, { installed: true });
  await f.adapter.act("disable", f.plugin.id);
  f.plugin.enabled = false;
  f.plugin.revision = "2.0.0";
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const p = await buildPlan(f.ctx),
    result = await applyPlan(f.ctx, p.approval);
  f.adapter.list = async () => [];
  f.calls.length = 0;
  const undo = await restorePlan(f.ctx, result.backupId);
  assert.ok(
    undo.conflicts.some((c) => c.includes("Cannot install disabled target")),
  );
  await assert.rejects(
    restore(f.ctx, result.backupId, undo.approval),
    /disabled target/,
  );
  assert.deepEqual(f.calls, []);
});

test("skipped settings are not parsed and are excluded from mixed-operation backup and restore", async (t) => {
  const f = await fixture(t);
  f.plugin.enabled = false;
  f.manifest.plugins.push({
    id: "firstmate",
    source: "npm:firstmate",
    revision: "0.4.0",
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await mkdir(path.dirname(f.setting), { recursive: true });
  await writeFile(f.setting, "{invalid orphan JSON");
  const p = await buildPlan(f.ctx);
  assert.deepEqual(p.conflicts, []);
  const original = f.adapter.install;
  f.adapter.install = async (target) => {
    await writeFile(f.setting, "external change during apply");
    return original(target);
  };
  const result = await applyPlan(f.ctx, p.approval);
  assert.equal(result.verification.configurationMatches, true);
  const b = JSON.parse(await readFile(result.backupFile, "utf8"));
  assert.deepEqual(
    b.profile.manifest.plugins.map((p) => p.id),
    ["firstmate"],
  );
  await writeFile(f.setting, "another external change after apply");
  const undo = await restorePlan(f.ctx, result.backupId);
  assert.deepEqual(undo.conflicts, []);
  assert.equal(undo.currentChangedSinceBackup, false);
  await restore(f.ctx, result.backupId, undo.approval);
  assert.equal(
    await readFile(f.setting, "utf8"),
    "another external change after apply",
  );
});

test("restore never rolls back external settings changes for a plugin skipped by the operation", async (t) => {
  const f = await fixture(t);
  f.plugin.enabled = false;
  f.manifest.plugins.push({
    id: "firstmate",
    source: "npm:firstmate",
    revision: "0.4.0",
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const original = f.adapter.install;
  const external = { version: 1, values: { previewWrap: true } };
  f.adapter.install = async (target) => {
    await writeJson(f.setting, external);
    return original(target);
  };
  const p = await buildPlan(f.ctx),
    r = await applyPlan(f.ctx, p.approval);
  const undo = await restorePlan(f.ctx, r.backupId);
  const restored = await restore(f.ctx, r.backupId, undo.approval);
  assert.deepEqual(restored.retainedDisabledPlugins, ["firstmate"]);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), external);
});

test("applies and updates offline bundle plugins idempotently", async (t) => {
  const f = await fixture(t);
  const bundleSourceDir = path.join(f.home, "tool-source");
  await mkdir(bundleSourceDir, { recursive: true });
  await writeFile(
    path.join(bundleSourceDir, "paseo-plugin.json"),
    JSON.stringify({ id: "my-tool", name: "My Tool" }),
  );
  await writeFile(
    path.join(bundleSourceDir, "index.js"),
    "console.log('version 1');",
  );
  const packedV1 = await packPluginDirectory(bundleSourceDir);
  const bundleFile = path.join(f.root, "bundles/my-tool.tar.gz");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, packedV1.buffer);

  f.manifest.plugins.push({
    id: "my-tool",
    source: "bundle:bundles/my-tool.tar.gz",
    revision: packedV1.sha256,
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  // 1. Build plan should identify install action
  const plan1 = await buildPlan(f.ctx);
  const toolChange = plan1.changes.find((c) => c.plugin === "my-tool");
  assert.ok(toolChange, "Plan should have change for my-tool");
  assert.deepEqual(toolChange.actions, ["install"]);

  // 2. Apply plan
  const result1 = await applyPlan(f.ctx, plan1.approval);
  assert.equal(result1.changed, true);

  // Verify unpacked files
  const installedDir = path.join(f.home, "local-plugins/my-tool");
  assert.equal(
    await readFile(path.join(installedDir, "index.js"), "utf8"),
    "console.log('version 1');",
  );
  const meta1 = JSON.parse(
    await readFile(path.join(installedDir, ".paseo-sync-bundle.json"), "utf8"),
  );
  assert.equal(meta1.source, "bundle:bundles/my-tool.tar.gz");
  assert.equal(meta1.revision, packedV1.sha256);

  // 3. Second plan should be idempotent
  const plan2 = await buildPlan(f.ctx);
  assert.equal(plan2.changes.length, 0);

  // 4. Update bundle to version 2
  await writeFile(
    path.join(bundleSourceDir, "index.js"),
    "console.log('version 2');",
  );
  const packedV2 = await packPluginDirectory(bundleSourceDir);
  await writeFile(bundleFile, packedV2.buffer);

  const manifestTarget = f.manifest.plugins.find((p) => p.id === "my-tool");
  manifestTarget.revision = packedV2.sha256;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  const plan3 = await buildPlan(f.ctx);
  const updateChange = plan3.changes.find((c) => c.plugin === "my-tool");
  assert.ok(updateChange, "Plan should have change for my-tool update");
  assert.deepEqual(updateChange.actions, ["update"]);

  const result2 = await applyPlan(f.ctx, plan3.approval);
  assert.equal(result2.changed, true);
  assert.equal(
    await readFile(path.join(installedDir, "index.js"), "utf8"),
    "console.log('version 2');",
  );
  const meta2 = JSON.parse(
    await readFile(path.join(installedDir, ".paseo-sync-bundle.json"), "utf8"),
  );
  assert.equal(meta2.revision, packedV2.sha256);

  // 5. Restore backup from update rolls back V2 to V1 from cached bundle bytes
  const restorePreview = await restorePlan(f.ctx, result2.backupId);
  assert.equal(restorePreview.conflicts.length, 0);
  assert.equal(restorePreview.currentChangedSinceBackup, false);
  await restore(f.ctx, result2.backupId, restorePreview.approval);
  assert.equal(
    await readFile(path.join(installedDir, "index.js"), "utf8"),
    "console.log('version 1');",
  );
  const metaRestored = JSON.parse(
    await readFile(path.join(installedDir, ".paseo-sync-bundle.json"), "utf8"),
  );
  assert.equal(metaRestored.revision, packedV1.sha256);
});

test("detects edits to installed bundle plugins and skips destructive update", async (t) => {
  const f = await fixture(t);
  const bundleSourceDir = path.join(f.home, "tool-source");
  await mkdir(bundleSourceDir, { recursive: true });
  await writeFile(
    path.join(bundleSourceDir, "paseo-plugin.json"),
    JSON.stringify({ id: "my-tool", name: "My Tool" }),
  );
  await writeFile(path.join(bundleSourceDir, "index.js"), "v1;");
  const packedV1 = await packPluginDirectory(bundleSourceDir);
  const bundleFile = path.join(f.root, "bundles/my-tool.tar.gz");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, packedV1.buffer);

  f.manifest.plugins.push({
    id: "my-tool",
    source: "bundle:bundles/my-tool.tar.gz",
    revision: packedV1.sha256,
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  const plan1 = await buildPlan(f.ctx);
  await applyPlan(f.ctx, plan1.approval);

  const installedDir = path.join(f.home, "local-plugins/my-tool");

  // 1. Edit installed file
  await writeFile(path.join(installedDir, "index.js"), "locally edited v1;");

  // Verify should report mismatch
  const v = await verify(f.ctx);
  assert.equal(v.configurationMatches, false);
  assert.ok(v.differences.includes("source:my-tool"));

  // 2. Profile updates to v2
  await writeFile(path.join(bundleSourceDir, "index.js"), "v2;");
  const packedV2 = await packPluginDirectory(bundleSourceDir);
  await writeFile(bundleFile, packedV2.buffer);
  f.manifest.plugins.find((p) => p.id === "my-tool").revision = packedV2.sha256;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  // 3. Plan should skip my-tool with local-source-changes instead of destroying edits
  const plan2 = await buildPlan(f.ctx);
  const toolSkip = plan2.skipped.find((s) => s.plugin === "my-tool");
  assert.ok(toolSkip, "my-tool should be skipped");
  assert.equal(toolSkip.reason, "local-source-changes");
  assert.deepEqual(toolSkip.files, ["index.js"]);
  assert.equal(plan2.changes.some((c) => c.plugin === "my-tool"), false);
});

test("refuses to update external unmanaged directory checkout with bundle", async (t) => {
  const f = await fixture(t);
  const externalDir = path.join(f.home, "external-checkout");
  await mkdir(externalDir, { recursive: true });
  await writeFile(
    path.join(externalDir, "paseo-plugin.json"),
    JSON.stringify({ id: "ext-tool" }),
  );
  await writeFile(path.join(externalDir, "index.js"), "ext v1;");

  // Install as external directory directly in adapter
  await f.adapter.install({
    id: "ext-tool",
    source: externalDir,
    revision: "local",
    enabled: true,
  });

  const bundleFile = path.join(f.root, "bundles/ext-tool.tar.gz");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  const remoteDir = path.join(f.home, "remote-tool-source");
  await mkdir(remoteDir, { recursive: true });
  await writeFile(
    path.join(remoteDir, "paseo-plugin.json"),
    JSON.stringify({ id: "ext-tool" }),
  );
  await writeFile(path.join(remoteDir, "index.js"), "remote v2;");
  const packedV2 = await packPluginDirectory(remoteDir);
  await writeFile(bundleFile, packedV2.buffer);

  f.manifest.plugins.push({
    id: "ext-tool",
    source: "bundle:bundles/ext-tool.tar.gz",
    revision: packedV2.sha256,
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  // 1. Plan should skip external directory checkout
  const plan = await buildPlan(f.ctx);
  const extSkip = plan.skipped.find((s) => s.plugin === "ext-tool");
  assert.ok(extSkip, "ext-tool should be skipped");
  assert.equal(extSkip.reason, "local-source-changes");
  assert.equal(extSkip.checkout, externalDir);

  // 2. Direct attempt to update external directory with bundle must throw
  const { installOrUpdateBundlePlugin } = await import("../server/core/sync.mjs");
  await assert.rejects(
    async () => {
      await installOrUpdateBundlePlugin(f.ctx, f.manifest.plugins.find((p) => p.id === "ext-tool"), true, externalDir);
    },
    {
      message: /Cannot update external plugin checkout with bundle/,
    },
  );
});

test("protects unmarked development directory inside local-plugins from destructive bundle updates and supports same-revision changes", async (t) => {
  const f = await fixture(t);
  const localDevDir = path.join(f.home, "local-plugins/dev-tool");
  await mkdir(localDevDir, { recursive: true });
  await writeFile(
    path.join(localDevDir, "paseo-plugin.json"),
    JSON.stringify({ id: "dev-tool" }),
  );
  await writeFile(path.join(localDevDir, "index.js"), "dev v1;");
  // Ignored local secret that is excluded from bundle packing but exists on disk
  await writeFile(path.join(localDevDir, ".env"), "SECRET_TOKEN=keep-me");

  // Pack v1 from the same source so revision matches
  const packedV1 = await packPluginDirectory(localDevDir);
  const bundleFile = path.join(f.root, "bundles/dev-tool.tar.gz");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, packedV1.buffer);

  // Register as an unmarked directory plugin (no .paseo-sync-bundle.json on disk)
  await f.adapter.install({
    id: "dev-tool",
    source: localDevDir,
    revision: "local",
    enabled: true,
  });

  // 1. Same-revision disable change on unmarked directory plugin must succeed through buildPlan -> applyPlan -> restore
  f.manifest.plugins.push({
    id: "dev-tool",
    source: "bundle:bundles/dev-tool.tar.gz",
    revision: packedV1.sha256,
    enabled: false,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  const planDisable = await buildPlan(f.ctx);
  assert.deepEqual(planDisable.conflicts, []);
  const disableChange = planDisable.changes.find((c) => c.plugin === "dev-tool");
  assert.ok(disableChange, "Should plan disable for same-revision unmarked directory plugin");
  assert.deepEqual(disableChange.actions, ["disable"]);

  const appliedDisable = await applyPlan(f.ctx, planDisable.approval);
  assert.equal(appliedDisable.changed, true);
  assert.equal(appliedDisable.verification.configurationMatches, true);
  assert.equal((await f.adapter.list()).find((p) => p.id === "dev-tool").enabled, false);
  // .env must still be intact
  assert.equal(await readFile(path.join(localDevDir, ".env"), "utf8"), "SECRET_TOKEN=keep-me");

  const undoDisable = await restorePlan(f.ctx, appliedDisable.backupId);
  assert.deepEqual(undoDisable.conflicts, []);
  await restore(f.ctx, appliedDisable.backupId, undoDisable.approval);
  assert.equal((await f.adapter.list()).find((p) => p.id === "dev-tool").enabled, true);

  // 2. Now update bundle in profile to v2 while localDevDir remains an unmarked checkout
  const remoteDir = path.join(f.home, "remote-dev-tool");
  await mkdir(remoteDir, { recursive: true });
  await writeFile(
    path.join(remoteDir, "paseo-plugin.json"),
    JSON.stringify({ id: "dev-tool" }),
  );
  await writeFile(path.join(remoteDir, "index.js"), "remote v2;");
  const packedV2 = await packPluginDirectory(remoteDir);
  await writeFile(bundleFile, packedV2.buffer);

  const targetEntry = f.manifest.plugins.find((p) => p.id === "dev-tool");
  targetEntry.revision = packedV2.sha256;
  targetEntry.enabled = true;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  // buildPlan must skip dev-tool rather than scheduling a destructive update
  const planUpdate = await buildPlan(f.ctx);
  const devSkip = planUpdate.skipped.find((s) => s.plugin === "dev-tool");
  assert.ok(devSkip, "unmarked directory in local-plugins should be skipped on revision change");
  assert.equal(devSkip.reason, "local-source-changes");
  assert.equal(devSkip.checkout, localDevDir);
  assert.equal(planUpdate.changes.some((c) => c.plugin === "dev-tool"), false);

  // Direct call to installOrUpdateBundlePlugin must also refuse to wipe unmarked localDevDir
  const { installOrUpdateBundlePlugin } = await import("../server/core/sync.mjs");
  await assert.rejects(
    async () => {
      await installOrUpdateBundlePlugin(f.ctx, targetEntry, true, localDevDir);
    },
    /Cannot (?:update|overwrite) unmarked plugin directory with bundle/,
  );
  assert.equal(await readFile(path.join(localDevDir, ".env"), "utf8"), "SECRET_TOKEN=keep-me");
});
