import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, writeJson } from "../server/core/files.mjs";
import { packPluginDirectory, BUNDLE_MARKER } from "../server/core/bundle.mjs";
import { loadProfile } from "../server/core/profile.mjs";
import {
  buildPlan,
  applyPlan,
  verify,
  restorePlan,
  restore,
  isManagedLocalPath,
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
              ...(p.registry ? { registry: p.registry } : {}),
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
      if (action === "remove") {
        // Uninstalling removes the plugin's code and its settings directory.
        rows = rows.filter((x) => x.id !== id);
        await rm(path.join(home, "plugin-settings", id), {
          recursive: true,
          force: true,
        });
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

test("a live presentation document with legacy spellings previews, applies, and keeps local-change protection", async (t) => {
  const f = await fixture(t, { installed: true });
  // The daemon keeps better-paseo's legacy spellings on disk until the plugin
  // rewrites them; reading such a host document used to fail the preview with
  // "Invalid fields; expected accent, ...".
  await writeJson(f.setting, {
    version: 1,
    values: { previewWrap: true, rowLabels: true, hoverDelay: "500ms", detailsTextZoom: 2 },
  });
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: true, rowLabelStyle: "both", hoverDelaySeconds: 0.5 },
  });
  let p = await buildPlan(f.ctx);
  // Semantically equal documents produce no phantom settings change.
  assert.equal(p.changes.length, 0);
  await applyPlan(f.ctx, p.approval);
  // A repository change over an untouched legacy local spelling schedules the
  // canonical write without a phantom conflict.
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: false, rowLabelStyle: "both", hoverDelaySeconds: 0.5 },
  });
  p = await buildPlan(f.ctx);
  assert.equal(p.conflicts.length, 0);
  assert.deepEqual(
    p.changes.flatMap((c) => c.actions),
    ["settings:presentation"],
  );
  await applyPlan(f.ctx, p.approval);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), {
    version: 1,
    values: { previewWrap: false, rowLabelStyle: "both", hoverDelaySeconds: 0.5 },
  });
  assert.equal((await verify(f.ctx)).configurationMatches, true);
  // Reappearing in the legacy spelling of the synchronized state is not a change.
  await writeJson(f.setting, {
    version: 1,
    values: { previewWrap: false, rowLabels: true, hoverDelay: "500ms", detailsTextZoom: 2 },
  });
  p = await buildPlan(f.ctx);
  assert.equal(p.changes.length, 0);
  assert.equal(p.conflicts.length, 0);
  // A local edit made through a legacy spelling still counts as protected.
  await writeJson(f.setting, {
    version: 1,
    values: { previewWrap: true, rowLabels: true, hoverDelay: "2s" },
  });
  p = await buildPlan(f.ctx);
  assert.ok(p.conflicts.some((x) => x.includes("Local changes conflict")));
});

test("restore succeeds when stored backup settings snapshot carries legacy spellings or formatting", async (t) => {
  const f = await fixture(t, { installed: true });
  // Host starts with previewWrap: false, repo target has previewWrap: true.
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const p = await buildPlan(f.ctx);
  assert.equal(p.changes.length, 1);
  const result = await applyPlan(f.ctx, p.approval);
  assert.ok(result.backupId);

  // Simulate an older backup whose before.settings captured legacy spellings
  // or formatted indentation (as written before live settings normalization).
  const bFile = path.join(f.state, "backups", `${result.backupId}.json`);
  const backup = JSON.parse(await readFile(bFile, "utf8"));
  const legacyBefore = {
    version: 1,
    values: { previewWrap: false, rowLabels: true, hoverDelay: "500ms", detailsTextZoom: 2 },
  };
  backup.before.settings["settings/better-paseo/presentation.json"] =
    Buffer.from(JSON.stringify(legacyBefore, null, 2)).toString("base64");
  await writeJson(bFile, backup);

  const preview = await restorePlan(f.ctx, result.backupId);
  const restored = await restore(f.ctx, result.backupId, preview.approval);
  assert.equal(restored.restored, true);
  const onDisk = JSON.parse(await readFile(f.setting, "utf8"));
  assert.equal(onDisk.values.previewWrap, false);
  assert.equal(onDisk.values.rowLabels, true);
  assert.equal(onDisk.values.hoverDelay, "500ms");
});

test("applies the newer accent and inline code color choices better-paseo publishes", async (t) => {
  const f = await fixture(t);
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { accent: "zinc", inlineCodeColor: "ghostty" },
  });
  const p = await buildPlan(f.ctx);
  await applyPlan(f.ctx, p.approval);
  const stored = JSON.parse(await readFile(f.setting, "utf8"));
  assert.equal(stored.values.accent, "zinc");
  assert.equal(stored.values.inlineCodeColor, "ghostty");
  assert.equal((await verify(f.ctx)).configurationMatches, true);
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
    { execFileSync } = await import("node:child_process");
  const row = (await f.adapter.list())[0];
  // Keep the fixture's own paths: the tmpdir prefix carries a symlinked
  // component on macOS (/var → /private/var) and a linked daemon home must
  // not defeat sourceState's patch allowance nor installedFile; both
  // derive names from the canonical roots.
  const checkout = row.path;
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

test("staged bundle extraction preserves existing installation and allows rollback when archive extraction fails", async (t) => {
  const f = await fixture(t);
  const bundleSourceDir = path.join(f.home, "stage-tool-src");
  await mkdir(bundleSourceDir, { recursive: true });
  await writeFile(
    path.join(bundleSourceDir, "paseo-plugin.json"),
    JSON.stringify({ id: "stage-tool" }),
  );
  await writeFile(path.join(bundleSourceDir, "index.js"), "v1-working;");
  const packedV1 = await packPluginDirectory(bundleSourceDir);
  const bundleFile = path.join(f.root, "bundles/stage-tool.tar.gz");
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, packedV1.buffer);

  f.manifest.plugins.push({
    id: "stage-tool",
    source: "bundle:bundles/stage-tool.tar.gz",
    revision: packedV1.sha256,
    enabled: true,
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  // Install V1
  const plan1 = await buildPlan(f.ctx);
  await applyPlan(f.ctx, plan1.approval);
  const installedDir = path.join(f.home, "local-plugins/stage-tool");
  assert.equal(await readFile(path.join(installedDir, "index.js"), "utf8"), "v1-working;");

  // Replace bundle archive with invalid gzip bytes whose sha256 matches target.revision
  const { createHash } = await import("node:crypto");
  const corruptBytes = Buffer.from("not-a-valid-gzip-archive");
  const corruptSha = createHash("sha256").update(corruptBytes).digest("hex");
  await writeFile(bundleFile, corruptBytes);
  f.manifest.plugins.find((p) => p.id === "stage-tool").revision = corruptSha;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);

  const plan2 = await buildPlan(f.ctx);
  let failedBackupId = null;
  await assert.rejects(
    async () => {
      await applyPlan(f.ctx, plan2.approval);
    },
    (err) => {
      failedBackupId = err.backupId;
      return Boolean(failedBackupId);
    },
  );

  // Working V1 installation and its bundle marker must remain intact
  assert.equal(await readFile(path.join(installedDir, "index.js"), "utf8"), "v1-working;");
  const marker = JSON.parse(
    await readFile(path.join(installedDir, ".paseo-sync-bundle.json"), "utf8"),
  );
  assert.equal(marker.revision, packedV1.sha256);

  // Rollback via restorePlan + restore must succeed cleanly
  const restorePreview = await restorePlan(f.ctx, failedBackupId);
  assert.deepEqual(restorePreview.conflicts, []);
  await restore(f.ctx, failedBackupId, restorePreview.approval);
  assert.equal(await readFile(path.join(installedDir, "index.js"), "utf8"), "v1-working;");
  assert.equal((await f.adapter.list()).find((p) => p.id === "stage-tool").enabled, true);
});

test("preferProfile skips unsupported registry version transitions as disclosed skips while applying other plugins", async (t) => {
  const f = await fixture(t, { installed: true });
  // Initial sync to establish baseline
  let p = await buildPlan(f.ctx);
  await applyPlan(f.ctx, p.approval);

  // Add a registry-installed plugin locally at 1.1.1 while profile wants 1.0.1,
  // and modify better-paseo settings locally so both localConflict and registry transition exist.
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows.push({
      id: "paseo-cafe",
      path: path.join(f.home, "plugins/paseo-cafe/1.1.1"),
      enabled: true,
      status: "running",
      installation: {
        identity: {
          kind: "npm",
          packageName: "paseo-cafe",
          pluginPath: ".",
          registry: { url: "https://plugins.paseo.sh", id: "paseo-cafe/cafe" },
        },
        currentRevision: "1.1.1",
      },
    });
    return rows;
  };
  f.manifest.plugins.push({
    id: "paseo-cafe",
    source: "npm:paseo-cafe",
    revision: "1.0.1",
    enabled: true,
    registry: { url: "https://plugins.paseo.sh", id: "paseo-cafe/cafe" },
  });
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  await writeJson(path.join(f.root, f.manifest.settings[0].file), {
    version: 1,
    values: { previewWrap: true, previewStripes: true },
  });

  const normal = await buildPlan(f.ctx);
  assert.ok(normal.conflicts.some((x) => /Local changes conflict/i.test(x)));
  assert.ok(normal.conflicts.some((x) => /Exact registry version transition/i.test(x)));

  const preferred = await buildPlan({ ...f.ctx, preferProfile: true });
  assert.equal(preferred.preferProfile, true);
  assert.deepEqual(preferred.conflicts, []);
  assert.deepEqual(preferred.skipped, [
    {
      plugin: "paseo-cafe",
      reason: "registry-version-transition",
      head: "1.1.1",
      revision: "1.0.1",
    },
  ]);
  const res = await applyPlan(
    { ...f.ctx, preferProfile: true },
    preferred.approval,
  );
  assert.equal(res.changed, true);
  assert.equal(res.verification.configurationMatches, true);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: true,
    previewStripes: true,
  });
});

test("reinstallRegistry aligns a registry version transition end to end and its backup restores through reinstall", async (t) => {
  const f = await fixture(t, { installed: true });
  // The plugin came from a Paseo registry listing, and the daemon only offers
  // approved registry upgrades: the host drifted to 2.0.0 (with local
  // settings edits) while the profile pins the reviewed 1.0.0.
  f.manifest.plugins[0].registry = {
    url: "https://plugins.paseo.sh",
    id: "example/demo",
  };
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  // Simulate the persistent host drift through the adapter itself: the
  // daemon upgraded the plugin to 2.0.0 from the registry listing.
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({
    ...f.plugin,
    revision: "2.0.0",
    registry: { url: "https://plugins.paseo.sh", id: "example/demo" },
  });
  f.calls.length = 0;
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  // A host-only settings document the profile does not manage: removing the
  // installation deletes the settings directory, so the reinstall must
  // capture and rewrite it instead of losing it.
  const hostOnly = path.join(
    f.home,
    "plugin-settings/better-paseo/extra.json",
  );
  await writeFile(hostOnly, JSON.stringify({ hostOnly: true }));

  const normal = await buildPlan(f.ctx);
  assert.ok(
    normal.conflicts.some((x) => /Local changes conflict/i.test(x)),
  );
  assert.ok(
    normal.conflicts.some((x) => /Exact registry version transition/i.test(x)),
  );

  const preferred = await buildPlan({ ...f.ctx, preferProfile: true });
  assert.equal(preferred.reinstallRegistry, false);
  assert.deepEqual(preferred.skipped, [
    {
      plugin: "better-paseo",
      reason: "registry-version-transition",
      head: "2.0.0",
      revision: "1.0.0",
    },
  ]);

  const plan = await buildPlan({
    ...f.ctx,
    preferProfile: true,
    reinstallRegistry: true,
  });
  assert.equal(plan.reinstallRegistry, true);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changes.map((c) => c.actions), [
    ["reinstall", "settings:presentation"],
  ]);
  assert.equal(plan.changes[0].from.revision, "2.0.0");
  assert.equal(plan.changes[0].to.revision, "1.0.0");
  assert.notEqual(plan.approval, preferred.approval);

  const applied = await applyPlan(
    { ...f.ctx, preferProfile: true, reinstallRegistry: true },
    plan.approval,
  );
  assert.equal(applied.changed, true);
  assert.equal(applied.verification.configurationMatches, true);
  assert.ok(
    f.calls.some(([a, id]) => a === "remove" && id === "better-paseo"),
  );
  assert.ok(
    f.calls.some(
      ([a, id, rev]) =>
        a === "install" && id === "better-paseo" && rev === "1.0.0",
    ),
  );
  assert.ok(!f.calls.some(([a]) => a === "update"));
  // Removal deleted the settings directory; the reinstall path still
  // rewrites the profile settings instead of tripping the concurrency guard,
  // and restores the host-only document that is not part of the profile.
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: true,
  });
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
    hostOnly: true,
  });
  const alignedRow = (await f.adapter.list())[0];
  assert.equal(alignedRow.installation.currentRevision, "1.0.0");
  assert.deepEqual(alignedRow.installation.identity.registry, {
    url: "https://plugins.paseo.sh",
    id: "example/demo",
  });
  // The host is now fully aligned: a plain plan has nothing left to do.
  const aligned = await buildPlan(f.ctx);
  assert.deepEqual(aligned.changes, []);
  assert.deepEqual(aligned.conflicts, []);
  assert.deepEqual(aligned.skipped, []);

  // The backup produced by the reinstall rolls back through reinstall too.
  const restorePreview = await restorePlan(f.ctx, applied.backupId);
  assert.deepEqual(restorePreview.conflicts, []);
  assert.deepEqual(
    restorePreview.changes.map((c) => c.actions),
    [["reinstall"]],
  );
  assert.equal(restorePreview.changes[0].to.revision, "2.0.0");
  f.calls.length = 0;
  await restore(f.ctx, applied.backupId, restorePreview.approval);
  assert.ok(
    f.calls.some(([a, id]) => a === "remove" && id === "better-paseo"),
  );
  assert.ok(
    f.calls.some(
      ([a, id, rev]) =>
        a === "install" && id === "better-paseo" && rev === "2.0.0",
    ),
  );
  const restoredRow = (await f.adapter.list())[0];
  assert.equal(restoredRow.installation.currentRevision, "2.0.0");
  // The backed-up local settings drift comes back with the rollback, and the
  // host-only document survives the restore-side reinstall as well.
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: false,
  });
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
    hostOnly: true,
  });
});

test("reinstallRegistry never reinstalls a profile-disabled registry plugin", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  f.manifest.plugins[0].enabled = false;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  // The daemon upgraded the plugin to 2.0.0 while the profile pins 1.0.0
  // disabled. Installing immediately enables code, so even the explicit
  // reinstall mode must keep the disclosed skip instead of executing it.
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  await f.adapter.act("disable", "better-paseo");
  f.calls.length = 0;

  const plan = await buildPlan({
    ...f.ctx,
    preferProfile: true,
    reinstallRegistry: true,
  });
  assert.equal(plan.reinstallRegistry, true);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.skipped, [
    {
      plugin: "better-paseo",
      reason: "registry-version-transition",
      head: "2.0.0",
      revision: "1.0.0",
    },
  ]);
  const applied = await applyPlan(
    { ...f.ctx, preferProfile: true, reinstallRegistry: true },
    plan.approval,
  );
  assert.equal(applied.changed, false);
  assert.ok(!f.calls.some(([a]) => a === "remove" || a === "install"));
  assert.equal(
    (await f.adapter.list())[0].installation.currentRevision,
    "2.0.0",
  );
});

test("a registry rollback pinned at a disabled revision refuses instead of reexecuting code", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  const applied = await applyPlan(
    { ...f.ctx, preferProfile: true, reinstallRegistry: true },
    (
      await buildPlan({
        ...f.ctx,
        preferProfile: true,
        reinstallRegistry: true,
      })
    ).approval,
  );
  assert.equal(applied.changed, true);
  // The backup pinned the pre-reinstall version, but as a disabled target:
  // rolling it back would have to install (and therefore execute) it first.
  const file = path.join(f.state, "backups", applied.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  b.before.plugins["better-paseo"].descriptor.enabled = false;
  await writeFile(file, JSON.stringify(b, null, 2));
  f.calls.length = 0;
  const preview = await restorePlan(f.ctx, applied.backupId);
  assert.ok(
    preview.conflicts.some((x) =>
      /Exact registry version transition/i.test(x),
    ),
  );
  assert.ok(
    !preview.changes.some(
      (c) => c.plugin === "better-paseo" && c.actions.includes("reinstall"),
    ),
  );
  await assert.rejects(restore(f.ctx, applied.backupId, preview.approval), /registry/i);
  assert.ok(!f.calls.some(([a]) => a === "remove" || a === "install"));
});

test("an in-place restore after a registry reinstall preserves current host-only settings", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  // The host-only document exists before the reinstall, so the apply-time
  // backup captures its pre-apply bytes.
  const hostOnly = path.join(
    f.home,
    "plugin-settings/better-paseo/extra.json",
  );
  await writeJson(hostOnly, { v: 1 });
  // A local settings drift so the backup's before-state has managed bytes
  // that the restore rolls back.
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const applied = await applyPlan(
    { ...f.ctx, preferProfile: true, reinstallRegistry: true },
    (
      await buildPlan({
        ...f.ctx,
        preferProfile: true,
        reinstallRegistry: true,
      })
    ).approval,
  );
  assert.equal(applied.changed, true);
  // The production adapter's reinstall drops registry provenance, so the
  // installed row no longer classifies as a registry rollback and the
  // restore takes the ordinary in-place update path, with no removal.
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    delete rows[0].installation.identity.registry;
    return rows;
  };
  // Local edits to the host-only document after the apply must survive the
  // in-place restore; they are invisible to the drift guard by design.
  await writeJson(hostOnly, { editedAfterApply: true });
  const preview = await restorePlan(f.ctx, applied.backupId);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.currentChangedSinceBackup, false);
  assert.ok(
    !preview.changes.some((c) => c.actions.includes("reinstall")),
  );
  await restore(f.ctx, applied.backupId, preview.approval);
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
    editedAfterApply: true,
  });
  // The profile-managed settings document still rolls back to the backed-up
  // local drift, while the host-only document keeps the newer local edit.
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: false,
  });
  // Deleting the host-only document afterwards is a deliberate local
  // change: the completed apply dropped its capture, so a later restore
  // must not resurrect it.
  await rm(hostOnly, { force: true });
  const again = await restorePlan(f.ctx, applied.backupId);
  await restore(f.ctx, applied.backupId, again.approval);
  await assert.rejects(readFile(hostOnly), (e) => e.code === "ENOENT");
});

test("a restore recovers host-only settings captured before a failed reinstall", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  const hostOnly = path.join(
    f.home,
    "plugin-settings/better-paseo/extra.json",
  );
  await writeJson(hostOnly, { v: 1 });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const ctx = { ...f.ctx, preferProfile: true, reinstallRegistry: true };
  const plan = await buildPlan(ctx);
  // The removal succeeds but the installation fails (e.g. no network): the
  // captured host-only documents survive only inside the failed backup.
  // Successful installs recreate managed settings documents with fresh
  // defaults, exactly like the daemon does.
  const install = f.adapter.install;
  f.adapter.install = async (p) => {
    if (p.revision === "1.0.0") throw new Error("network unavailable");
    const result = await install(p);
    await writeJson(f.setting, {
      version: 1,
      values: { freshDefaults: true },
    });
    return result;
  };
  let failure;
  await assert.rejects(applyPlan(ctx, plan.approval), (e) => {
    failure = e;
    return Boolean(e.backupId);
  });
  const preview = await restorePlan(f.ctx, failure.backupId);
  assert.deepEqual(preview.conflicts, []);
  await restore(f.ctx, failure.backupId, preview.approval);
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), { v: 1 });
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: false,
  });
  assert.equal(
    (await f.adapter.list())[0].installation.currentRevision,
    "2.0.0",
  );
});

test("a restore recovers host-only documents left missing by a failed reinstall", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  const hostOnly = path.join(
    f.home,
    "plugin-settings/better-paseo/extra.json",
  );
  await writeJson(hostOnly, { v: 1 });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const ctx = { ...f.ctx, preferProfile: true, reinstallRegistry: true };
  const plan = await buildPlan(ctx);
  // Removal and installation succeed, but the apply dies on the
  // post-install disable — after the settings directory was deleted and
  // before the host-only rewrite, whose captured bytes now exist only in
  // the failed backup.
  const act = f.adapter.act;
  let disables = 0;
  f.adapter.act = async (action, id) => {
    if (action === "disable" && ++disables === 2)
      throw new Error("post-install disable failed");
    return act(action, id);
  };
  let failure;
  await assert.rejects(applyPlan(ctx, plan.approval), (e) => {
    failure = e;
    return Boolean(e.backupId);
  });
  f.adapter.act = act;
  // The production reinstall dropped registry provenance, so the restore
  // takes the in-place update path; the missing captured documents must
  // still be recovered.
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    delete rows[0].installation.identity.registry;
    return rows;
  };
  const preview = await restorePlan(f.ctx, failure.backupId);
  assert.deepEqual(preview.conflicts, []);
  await restore(f.ctx, failure.backupId, preview.approval);
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), { v: 1 });
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: false,
  });
  assert.equal(
    (await f.adapter.list())[0].installation.currentRevision,
    "2.0.0",
  );
});

test("a restore recovers captured host-only contents over recreated defaults but keeps later edits", async (t) => {
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  const setup = async () => {
    const f = await fixture(t, { installed: true });
    f.manifest.plugins[0].registry = registry;
    await writeJson(path.join(f.root, "profile.json"), f.manifest);
    await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
    await f.adapter.act("remove", "better-paseo");
    await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
    return f;
  };
  const hostOnlyOf = (f) =>
    path.join(f.home, "plugin-settings/better-paseo/extra.json");
  // A reinstall whose installation recreates the host-only document with
  // fresh defaults, then dies on the post-install disable before its
  // rewrite.
  const failAfterRecreatingDefaults = async (f, hostOnly) => {
    await writeJson(hostOnly, { exclusions: ["kept"] });
    await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
    const ctx = { ...f.ctx, preferProfile: true, reinstallRegistry: true };
    const plan = await buildPlan(ctx);
    const act = f.adapter.act,
      install = f.adapter.install;
    let disables = 0;
    f.adapter.install = async (p) => {
      const result = await install(p);
      if (p.revision === "1.0.0") await writeJson(hostOnly, {});
      return result;
    };
    f.adapter.act = async (action, id) => {
      if (action === "disable" && ++disables === 2)
        throw new Error("post-install disable failed");
      return act(action, id);
    };
    let failure;
    await assert.rejects(applyPlan(ctx, plan.approval), (e) => {
      failure = e;
      return Boolean(e.backupId);
    });
    f.adapter.act = act;
    f.adapter.install = install;
    const list = f.adapter.list;
    f.adapter.list = async () => {
      const rows = await list();
      delete rows[0].installation.identity.registry;
      return rows;
    };
    return failure;
  };

  // Case 1: the recreated defaults still sit untouched; the restore
  // recovers the captured contents over them.
  {
    const f = await setup(),
      hostOnly = hostOnlyOf(f),
      failure = await failAfterRecreatingDefaults(f, hostOnly);
    const preview = await restorePlan(f.ctx, failure.backupId);
    await restore(f.ctx, failure.backupId, preview.approval);
    assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
      exclusions: ["kept"],
    });
  }
  // Case 2: the user edited the recreated defaults after the failure; the
  // restore keeps that edit instead of the pre-apply capture.
  {
    const f = await setup(),
      hostOnly = hostOnlyOf(f),
      failure = await failAfterRecreatingDefaults(f, hostOnly);
    await writeJson(hostOnly, { editedAfterFailure: true });
    const preview = await restorePlan(f.ctx, failure.backupId);
    await restore(f.ctx, failure.backupId, preview.approval);
    assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
      editedAfterFailure: true,
    });
  }
});

test("a restore retry recovers captured contents over defaults from a failed recovery installation", async (t) => {
  const f = await fixture(t, { installed: true });
  const registry = { url: "https://plugins.paseo.sh", id: "example/demo" };
  f.manifest.plugins[0].registry = registry;
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  await f.adapter.act("remove", "better-paseo");
  await f.adapter.install({ ...f.plugin, revision: "2.0.0", registry });
  const hostOnly = path.join(
    f.home,
    "plugin-settings/better-paseo/extra.json",
  );
  await writeJson(hostOnly, { exclusions: ["kept"] });
  await writeJson(f.setting, { version: 1, values: { previewWrap: false } });
  const ctx = { ...f.ctx, preferProfile: true, reinstallRegistry: true };
  const plan = await buildPlan(ctx);
  // The apply's removal succeeds but its installation fails.
  const act = f.adapter.act,
    install = f.adapter.install;
  f.adapter.install = async (p) => {
    if (p.revision === "1.0.0") throw new Error("network unavailable");
    return install(p);
  };
  let failure;
  await assert.rejects(applyPlan(ctx, plan.approval), (e) => {
    failure = e;
    return Boolean(e.backupId);
  });
  // Restore #1: the recovery installation succeeds and recreates the
  // host-only document with defaults, but the post-install disable fails.
  let failNextDisable = false;
  f.adapter.install = async (p) => {
    const result = await install(p);
    if (p.revision === "2.0.0") {
      await writeJson(hostOnly, {});
      failNextDisable = true;
    }
    return result;
  };
  f.adapter.act = async (action, id) => {
    if (action === "disable" && failNextDisable) {
      failNextDisable = false;
      throw new Error("post-install disable failed");
    }
    return act(action, id);
  };
  const first = await restorePlan(f.ctx, failure.backupId);
  await assert.rejects(restore(f.ctx, failure.backupId, first.approval));
  f.adapter.install = install;
  f.adapter.act = act;
  // Restore #2 (retry, in-place): the recorded installation defaults let
  // the captured contents come back over the untouched defaults.
  const retry = await restorePlan(f.ctx, failure.backupId);
  assert.deepEqual(retry.conflicts, []);
  await restore(f.ctx, failure.backupId, retry.approval);
  assert.deepEqual(JSON.parse(await readFile(hostOnly, "utf8")), {
    exclusions: ["kept"],
  });
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")).values, {
    previewWrap: false,
  });
});

test("edits landing while a registry reinstall stops the plugin abort before removal", async (t) => {
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
  const pinned = git("rev-parse", "HEAD");
  await writeFile(path.join(row.path, "notes.txt"), "second\n");
  git("add", ".");
  git("commit", "-qm", "drift");
  const drifted = git("rev-parse", "HEAD");
  f.manifest.plugins[0].source = "git:https://github.com/example/demo";
  f.manifest.plugins[0].revision = pinned;
  f.manifest.plugins[0].registry = {
    url: "https://plugins.paseo.sh",
    id: "example/demo",
  };
  await writeJson(path.join(f.root, "profile.json"), f.manifest);
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {
      identity: {
        kind: "git",
        remote: "https://github.com/example/demo",
        pluginPath: ".",
        registry: { url: "https://plugins.paseo.sh", id: "example/demo" },
      },
      currentRevision: drifted,
    };
    return rows;
  };
  const ctx = { ...f.ctx, preferProfile: true, reinstallRegistry: true };
  const plan = await buildPlan(ctx);
  assert.ok(
    plan.changes.some(
      (c) => c.plugin === "better-paseo" && c.actions.includes("reinstall"),
    ),
  );
  // An editor saves a tracked file while the plugin is being disabled; the
  // removal must never run once the checkout no longer matches the snapshot.
  const act = f.adapter.act;
  f.adapter.act = async (action, id) => {
    if (action === "disable")
      await writeFile(path.join(row.path, "index.client.tsx"), "local work");
    return act(action, id);
  };
  f.calls.length = 0;
  await assert.rejects(
    applyPlan(ctx, plan.approval),
    /Local source changed while stopping/,
  );
  assert.equal(
    await readFile(path.join(row.path, "index.client.tsx"), "utf8"),
    "local work",
  );
  assert.ok(!f.calls.some(([a]) => a === "remove" || a === "install"));
});

test("registry reinstall disclosures and action labels render bilingually", async () => {
  const { translator, formatConflict } = await import("../client/i18n.mjs");
  const english = translator("en");
  assert.ok(
    english("卸载重装注册表插件对齐（重新预览）").includes(
      "Reinstall registry plugins to align",
    ),
  );
  assert.ok(english("卸载并重装").includes("reinstall"));
  assert.ok(
    english(
      "重装将按清单来源直装（npm 固定版本或 Git 固定提交），不再保留注册表安装来源；此后本机更新检查将使用该直装来源。",
    ).includes("no longer keeps the registry provenance"),
  );
  assert.ok(
    english(
      "已启用「注册表插件重装对齐」模式：版本不一致的注册表插件将卸载并重装为云端固定版本。",
    ).includes("Registry reinstall alignment"),
  );
  for (const language of ["zh", "en"]) {
    const line =
      "如需完全对齐 {plugin}，可点按「卸载重装注册表插件对齐（重新预览）」，用云端固定版本卸载并重装该插件。";
    const translated = translator(language)(line, { plugin: "better-paseo" });
    assert.ok(translated.includes("better-paseo"));
    assert.notEqual(translated, line);
  }
  assert.ok(
    formatConflict(
      "Exact registry version transition is not supported: better-paseo. Review registry provenance separately; no reinstall will be attempted.",
      english,
    ).includes("Reinstall registry plugins to align"),
  );
});

test("an untracked installation sharing the target id is disclosed and skipped instead of crashing apply", async (t) => {
  const f = await fixture(t, { installed: true });
  const row = (await f.adapter.list())[0];
  // The row exists but cannot be snapshotted: an untracked or local
  // development installation without usable installation metadata. It must
  // not be presented as an absent plugin (which offered a conflict-free
  // install that crashed applyPlan on the null descriptor).
  const list = f.adapter.list;
  f.adapter.list = async () => {
    const rows = await list();
    rows[0].installation = {};
    return rows;
  };
  const plan = await buildPlan(f.ctx);
  assert.deepEqual(plan.skipped, [
    { plugin: "better-paseo", reason: "untracked", checkout: row.path },
  ]);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changes, []);
  const { canConfirmPreview, translator } = await import("../client/i18n.mjs");
  // The skip is only a disclosure: confirm stays armed.
  assert.equal(canConfirmPreview({ ...plan, confirmKind: "apply" }), true);
  for (const language of ["zh", "en"]) {
    const line =
      "跳过 {plugin}：本地开发或未受管插件，本次不应用到本机。";
    const translated = translator(language)(line, { plugin: "better-paseo" });
    assert.ok(translated.includes("better-paseo"));
    assert.notEqual(translated, line);
  }
  const r = await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  assert.equal(r.changed, false);
  assert.deepEqual(f.calls, []);
});
test("restore discloses an unidentifiable backup entry instead of crashing on a null descriptor", async (t) => {
  const f = await fixture(t, { installed: true });
  const r = await applyPlan(f.ctx, (await buildPlan(f.ctx)).approval);
  // A failed or interrupted capture used to store this plugin as a record
  // with a null descriptor; restorePlan dereferenced it and crashed. Simulate
  // that legacy shape and expect an untracked disclosure instead.
  const file = path.join(f.state, "backups", r.backupId + ".json"),
    b = JSON.parse(await readFile(file, "utf8"));
  b.before.plugins["better-paseo"].descriptor = null;
  await writeFile(file, JSON.stringify(b, null, 2));
  const preview = await restorePlan(f.ctx, r.backupId);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.skipped, [
    { plugin: "better-paseo", reason: "untracked", restore: true },
  ]);
  const { canConfirmPreview, translator } = await import("../client/i18n.mjs");
  assert.equal(canConfirmPreview({ ...preview, confirmKind: "restore" }), true);
  for (const language of ["zh", "en"]) {
    const line =
      "跳过 {plugin}：备份或本机插件缺少可识别的安装来源，本次恢复不改动该插件。";
    const translated = translator(language)(line, { plugin: "better-paseo" });
    assert.ok(translated.includes("better-paseo"));
    assert.notEqual(translated, line);
  }
  f.calls.length = 0;
  const restored = await restore(f.ctx, r.backupId, preview.approval);
  assert.equal(restored.restored, true);
  // The unidentifiable installation is untouched: no adapter choreography
  // runs for it and its already-applied settings stay in place.
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(await readFile(f.setting, "utf8")), f.target);
});

test("unmarked directory plugin with recorded source patch synthesizes unpatched base revision across apply, re-plan, and restore", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-unmarked-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const pluginDir = path.join(home, "local-plugins", "patched-bundle");
  await mkdir(path.join(repo, "bundles"), { recursive: true });
  await mkdir(path.join(repo, "patches"), { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  await mkdir(state, { recursive: true });

  const unpatchedCode = 'export const mode = "default";\n';
  const patchedCode = 'export const mode = "patched";\n';
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "patched-bundle", name: "Patched Bundle" }),
  );
  await writeFile(path.join(pluginDir, "index.js"), unpatchedCode);

  const { packPluginDirectory } = await import("../server/core/bundle.mjs");
  const packed = await packPluginDirectory(pluginDir);
  await writeFile(
    path.join(repo, "bundles", "patched-bundle.tar.gz"),
    packed.buffer,
  );
  await writeFile(
    path.join(repo, "patches", "patched-bundle.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        plugin: "patched-bundle",
        revision: packed.sha256,
        files: [
          {
            path: "index.js",
            beforeSha256: digest(unpatchedCode),
            afterSha256: digest(patchedCode),
            find: '"default"',
            replace: '"patched"',
            count: 1,
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(repo, "profile.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        plugins: [
          {
            id: "patched-bundle",
            source: "bundle:bundles/patched-bundle.tar.gz",
            revision: packed.sha256,
            enabled: true,
          },
        ],
        settings: [],
        patches: [
          {
            plugin: "patched-bundle",
            file: "patches/patched-bundle.json",
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ pluginsEnabled: true }, null, 2),
  );

  let enabled = true;
  const adapter = {
    async list() {
      return [
        {
          id: "patched-bundle",
          enabled,
          status: "running",
          path: pluginDir,
          installation: {
            identity: { kind: "directory", path: pluginDir },
          },
        },
      ];
    },
    async install() {},
    async update() {},
    async reload() {},
    async act(action) {
      if (action === "enable") enabled = true;
      if (action === "disable") enabled = false;
    },
  };
  const ctx = { root: repo, home, state, adapter };

  const plan1 = await buildPlan(ctx);
  assert.deepEqual(plan1.skipped, []);
  assert.equal(plan1.changes.length, 1);
  assert.deepEqual(plan1.changes[0].actions, ["patch"]);

  const applied = await applyPlan(ctx, plan1.approval);
  assert.equal(applied.changed, true);
  assert.equal(applied.verification.configurationMatches, true);
  assert.equal(await readFile(path.join(pluginDir, "index.js"), "utf8"), patchedCode);

  const plan2 = await buildPlan(ctx);
  assert.deepEqual(plan2.skipped, []);
  assert.deepEqual(plan2.changes, []);

  const rPlan = await restorePlan(ctx, applied.backupId);
  assert.equal(rPlan.currentChangedSinceBackup, false);
  assert.deepEqual(rPlan.conflicts, []);

  const restored = await restore(ctx, applied.backupId, rPlan.approval);
  assert.equal(restored.restored, true);
  assert.equal(
    await readFile(path.join(pluginDir, "index.js"), "utf8"),
    unpatchedCode,
  );
});

test("isManagedLocalPath groups plugins by real location across symlinked spellings", async () => {
  // A linked daemon home leaves row.path spelled through a prefix that no
  // longer participates in the string containment against home, plus macOS
  // /var tmpdirs spell the base differently from its real location: derive
  // the fixture from realpath-ed mkdtemp and decide on the realpath of the
  // plugin path, like the other prefix-relative comparisons now do.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-managed-")));
  const home = path.join(base, "home");
  const plugin = path.join(home, "local-plugins", "better-paseo");
  try {
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, BUNDLE_MARKER), "{}", "utf8");
    await symlink(home, path.join(base, "paseo-alias"), "junction");
    // Managing decides on the real location: the plain spelling and a link
    // spelling of the same directory both belong to the managed area.
    assert.equal(await isManagedLocalPath(home, plugin), true);
    assert.equal(
      await isManagedLocalPath(home, path.join(base, "paseo-alias", "local-plugins", "better-paseo")),
      true,
    );
    // A link inside local-plugins must not turn an outside directory managed.
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, BUNDLE_MARKER), "{}", "utf8");
    await symlink(
      outside,
      path.join(home, "local-plugins", "escape"),
      "junction",
    );
    assert.equal(
      await isManagedLocalPath(home, path.join(home, "local-plugins", "escape")),
      false,
    );
    // A missing path is not a managed installation either.
    assert.equal(
      await isManagedLocalPath(home, path.join(base, "paseo-alias", "local-plugins", "ghost")),
      false,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("bundle update refuses a plugin root that is itself a symlink", async () => {
  // A plugin whose recorded installation path is spelled through a junction
  // planted directly at the plugin root: the real-location check accepts the
  // alias because its target lives inside the managed area, but a bundle
  // update renames the destination — renaming this spelling moves the link
  // itself and replaces it with a separate copy outside the managed area,
  // leaving the real installation stale (Codex P2 on PR #23). A root that is
  // a symlink joins the family's "the root itself is a symlink is refused"
  // invariants (safeFile / prepareRepository); links in ancestors still
  // resolve, like the link-spelled managed dir in the test above.
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "paseo-symlink-root-")),
  );
  const home = path.join(base, "home");
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  try {
    await mkdir(path.join(home, "local-plugins"), { recursive: true });
    await mkdir(root, { recursive: true });
    await mkdir(state, { recursive: true });
    const plugin = path.join(home, "local-plugins", "better-paseo");
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "index.js"), "version 1;");
    await writeFile(
      path.join(plugin, BUNDLE_MARKER),
      JSON.stringify({
        source: "bundle:bundles/better-paseo.tar.gz",
        revision: "r1",
      }),
      "utf8",
    );
    // The junction sits AT the plugin root: the location is managed, but a
    // rename on this spelling would move the link.
    const alias = path.join(base, "alias");
    await symlink(plugin, alias, "junction");
    assert.equal(await isManagedLocalPath(home, alias), false);

    const sourceDir = path.join(base, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      path.join(sourceDir, "paseo-plugin.json"),
      JSON.stringify({ id: "better-paseo", name: "Better Paseo" }),
      "utf8",
    );
    await writeFile(path.join(sourceDir, "index.js"), "version 2;");
    const packedV2 = await packPluginDirectory(sourceDir);
    await mkdir(path.join(root, "bundles"), { recursive: true });
    await writeFile(
      path.join(root, "bundles", "better-paseo.tar.gz"),
      packedV2.buffer,
    );

    const { installOrUpdateBundlePlugin } = await import(
      "../server/core/sync.mjs"
    );
    const ctx = { home, root, state, adapter: { async reload() {} } };
    await assert.rejects(
      installOrUpdateBundlePlugin(
        ctx,
        {
          id: "better-paseo",
          source: "bundle:bundles/better-paseo.tar.gz",
          revision: packedV2.sha256,
        },
        true,
        alias,
      ),
      /root is a symlink/,
    );
    // The refusal leaves both spellings untouched: the alias still resolves
    // to the untouched managed installation with its previous revision.
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(
      await readFile(path.join(plugin, "index.js"), "utf8"),
      "version 1;",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
