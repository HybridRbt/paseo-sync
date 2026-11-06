import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as repository from "../server/core/repository.mjs";
import { jsonOrNull, safeFile, writeJson } from "../server/core/files.mjs";
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "paseo-repository-"));
  const root = path.join(base, "repo"),
    state = path.join(base, "state"),
    home = path.join(base, "home");
  await mkdir(state);
  await mkdir(home);
  const git = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "-q", root]);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "README.md"), "private profile");
  git("add", ".");
  git("commit", "-qm", "init");
  const rows = [
    {
      id: "demo",
      enabled: true,
      status: "running",
      installation: {
        identity: { kind: "npm", packageName: "demo" },
        currentRevision: "1.0.0",
      },
    },
  ];
  return { root, state, home, adapter: { list: async () => rows }, git, rows };
}
test("preview never writes checkout; publish commits only reviewed portable files", async () => {
  assert.equal(typeof repository.publishPlan, "function");
  const f = await fixture();
  const p = await repository.publishPlan(f);
  assert.deepEqual(
    p.files.map((x) => x.path),
    ["profile.json"],
  );
  await assert.rejects(readFile(path.join(f.root, "profile.json")));
  const result = await repository.publish(f, p.approval, { push: false });
  assert.equal(result.committed, true);
  assert.equal(
    JSON.parse(await readFile(path.join(f.root, "profile.json"), "utf8"))
      .plugins[0].revision,
    "1.0.0",
  );
  assert.equal(f.git("status", "--porcelain"), "");
});
test("refuses changed plugin state, dirty worktrees, and credential-bearing clone URLs", async () => {
  const f = await fixture();
  const p = await repository.publishPlan(f);
  f.rows[0].installation.currentRevision = "2.0.0";
  await assert.rejects(
    repository.publish(f, p.approval, { push: false }),
    /stale/i,
  );
  await writeFile(path.join(f.root, "README.md"), "local edit");
  await assert.rejects(repository.publishPlan(f), /uncommitted|dirty/i);
  await assert.rejects(
    repository.prepareRepository(
      path.join(f.home, "new"),
      "https://token@example.com/a.git",
    ),
    /credential|URL/i,
  );
});
test("publishing targets the reviewed upstream branch, not the local branch name", async () => {
  const f = await fixture(),
    remote = path.join(path.dirname(f.root), "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  f.git("remote", "add", "origin", remote);
  f.git("push", "-u", "origin", "HEAD:shared");
  f.git("branch", "--set-upstream-to", "origin/shared");
  const p = await repository.publishPlan(f);
  assert.equal(p.upstream, "origin/shared");
  await repository.publish(f, p.approval);
  const remoteHead = execFileSync(
    "git",
    ["--git-dir", remote, "rev-parse", "refs/heads/shared"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(remoteHead, f.git("rev-parse", "HEAD"));
});
test("credential-bearing origin URLs are rejected before fetch or preview output", async () => {
  const f = await fixture();
  f.git(
    "remote",
    "add",
    "origin",
    "https://user:secret@example.invalid/profile.git",
  );
  await assert.rejects(repository.publishPlan(f), /origin.*credential/i);
});

test("successful publish advances baseline so later local changes can be published again", async () => {
  const f = await fixture();
  let p = await repository.publishPlan(f);
  await repository.publish(f, p.approval, { push: false });
  const { loadProfile } = await import("../server/core/profile.mjs");
  const { objectHash } = await import("../server/core/files.mjs");
  const plugin = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  ).plugins[0];
  await writeJson(path.join(f.state, "baseline.json"), {
    schemaVersion: 1,
    profileHash: (await loadProfile(f.root)).hash,
    plugins: { demo: plugin },
    settings: {},
    patches: {},
  });
  f.rows[0].installation.currentRevision = "2.0.0";
  p = await repository.publishPlan(f);
  await repository.publish(f, p.approval, { push: false });
  f.rows[0].installation.currentRevision = "3.0.0";
  p = await repository.publishPlan(f);
  assert.match(p.files[0].after, /3.0.0/);
});
test("publish preview binds the actual push URL and execution uses that reviewed URL", async () => {
  const f = await fixture(),
    fetch = path.join(path.dirname(f.root), "fetch.git"),
    push = path.join(path.dirname(f.root), "push.git");
  for (const dir of [fetch, push])
    execFileSync("git", ["init", "--bare", "-q", dir]);
  f.git("remote", "add", "origin", fetch);
  f.git("push", "-u", "origin", "HEAD:shared");
  f.git("branch", "--set-upstream-to", "origin/shared");
  f.git("remote", "set-url", "--push", "origin", push);
  const p = await repository.publishPlan(f);
  assert.equal(p.pushUrl, push);
  await repository.publish(f, p.approval);
  assert.equal(
    execFileSync("git", ["--git-dir", push, "rev-parse", "refs/heads/shared"], {
      encoding: "utf8",
    }).trim(),
    f.git("rev-parse", "HEAD"),
  );
});
test("changing only pushurl invalidates an existing publish approval", async () => {
  const f = await fixture(),
    a = path.join(path.dirname(f.root), "a.git"),
    b = path.join(path.dirname(f.root), "b.git");
  for (const dir of [a, b]) execFileSync("git", ["init", "--bare", "-q", dir]);
  f.git("remote", "add", "origin", a);
  f.git("push", "-u", "origin", "HEAD:shared");
  f.git("branch", "--set-upstream-to", "origin/shared");
  const p = await repository.publishPlan(f);
  f.git("remote", "set-url", "--push", "origin", b);
  await assert.rejects(repository.publish(f, p.approval), /stale/i);
});

test("publish preview discloses skipped dirty Git plugins instead of failing", async () => {
  const f = await fixture(),
    dir = path.join(f.home, "hot");
  await mkdir(dir);
  const hot = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  hot("init", "-q");
  hot("config", "user.name", "Test");
  hot("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "code.ts"), "one");
  hot("add", ".");
  hot("commit", "-qm", "one");
  f.rows.push({
    id: "hot",
    enabled: true,
    status: "running",
    path: dir,
    installation: {
      identity: {
        kind: "git",
        remote: "https://example.invalid/hot.git",
        pluginPath: ".",
      },
      currentRevision: hot("rev-parse", "HEAD"),
    },
  });
  await writeFile(path.join(dir, "code.ts"), "hotfix");
  const p = await repository.publishPlan(f);
  assert.deepEqual(p.skipped, [
    { plugin: "hot", reason: "local-source-changes", files: ["code.ts"] },
  ]);
  await repository.publish(f, p.approval, { push: false });
  const manifest = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  assert.ok(!manifest.plugins.some((x) => x.id === "hot"));
  assert.ok(manifest.plugins.some((x) => x.id === "demo"));
});
test("publish includes a Git plugin whose only local change is an install-generated file", async () => {
  const f = await fixture(),
    dir = path.join(f.home, "built");
  await mkdir(path.join(dir, "server"), { recursive: true });
  const built = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  built("init", "-q");
  built("config", "user.name", "Test");
  built("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "server/tasks-chunk.ts"), "export const TASKS_CHUNK = null;\n");
  built("add", ".");
  built("commit", "-qm", "initial");
  const revision = built("rev-parse", "HEAD");
  f.rows.push({
    id: "built",
    enabled: true,
    status: "running",
    path: dir,
    installation: {
      identity: {
        kind: "git",
        remote: "https://example.invalid/built.git",
        pluginPath: ".",
      },
      currentRevision: revision,
    },
  });
  // The install-time build step overwrote the committed placeholder with a
  // generated bundle: dirty by git status, clean by the generated marker.
  await writeFile(
    path.join(dir, "server/tasks-chunk.ts"),
    "// Generated by scripts/build-client.mjs at install. Do not edit or commit.\nexport const TASKS_CHUNK = { code: '\"use strict\";' };\n",
  );
  const p = await repository.publishPlan(f);
  assert.deepEqual(p.skipped, []);
  await repository.publish(f, p.approval, { push: false });
  const manifest = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  const entry = manifest.plugins.find((x) => x.id === "built");
  assert.ok(entry);
  assert.equal(entry.revision, revision);
});
test("publish preview discloses skipped untracked plugins instead of failing", async () => {
  const f = await fixture();
  f.rows.push({
    id: "flowly",
    enabled: true,
    status: "running",
    path: "/tmp/flowly",
    installation: {
      identity: {
        kind: "directory",
        path: "/tmp/flowly",
      },
    },
  });
  const p = await repository.publishPlan(f);
  assert.deepEqual(p.skipped, [
    { plugin: "flowly", reason: "untracked" },
  ]);
  await repository.publish(f, p.approval, { push: false });
  const manifest = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  assert.ok(!manifest.plugins.some((x) => x.id === "flowly"));
  assert.ok(manifest.plugins.some((x) => x.id === "demo"));
});
test("publish preview packages a valid directory plugin into a bundle without tripping captureBaseline guard", async () => {
  const f = await fixture();
  const dir = path.join(f.home, "flowly-checkout");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "paseo-plugin.json"),
    JSON.stringify({ id: "flowly", name: "Flowly" }),
  );
  await writeFile(path.join(dir, "index.js"), "console.log('flowly');");

  f.rows.push({
    id: "flowly",
    enabled: true,
    status: "running",
    path: dir,
    installation: {
      identity: {
        kind: "directory",
        path: dir,
      },
    },
  });

  const p = await repository.publishPlan(f);
  assert.deepEqual(p.skipped, []);
  assert.ok(p.files.some((x) => x.path === "bundles/flowly.tar.gz"));
  assert.ok(p.files.some((x) => x.path === "profile.json"));

  await repository.publish(f, p.approval, { push: false });
  const manifest = JSON.parse(
    await readFile(path.join(f.root, "profile.json"), "utf8"),
  );
  const flowlyEntry = manifest.plugins.find((x) => x.id === "flowly");
  assert.ok(flowlyEntry);
  assert.equal(flowlyEntry.source, "bundle:bundles/flowly.tar.gz");
  for (const fileEntry of p.files) {
    assert.equal("_bytes" in fileEntry, false, "publishPlan file entry must not leak raw _bytes buffer");
  }

  const baseline = await jsonOrNull(await safeFile(f.state, "baseline.json"));
  assert.ok(baseline?.plugins?.flowly);
  assert.equal(baseline.plugins.flowly.revision, flowlyEntry.revision);
});
test("a publish approval becomes stale when a skipped plugin recovers, even if files match", async () => {
  const f = await fixture(),
    dir = path.join(f.home, "hot");
  await mkdir(dir);
  const hot = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  hot("init", "-q");
  hot("config", "user.name", "Test");
  hot("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "code.ts"), "one");
  hot("add", ".");
  hot("commit", "-qm", "one");
  f.rows.push({
    id: "hot",
    enabled: true,
    status: "running",
    path: dir,
    installation: {
      identity: {
        kind: "git",
        remote: "https://example.invalid/hot.git",
        pluginPath: ".",
      },
      currentRevision: hot("rev-parse", "HEAD"),
    },
  });
  // First publish while the plugin is clean so the repository has its entry.
  let p = await repository.publishPlan(f);
  await repository.publish(f, p.approval, { push: false });
  await writeFile(path.join(dir, "code.ts"), "hotfix");
  p = await repository.publishPlan(f);
  assert.deepEqual(p.skipped, [
    {
      plugin: "hot",
      reason: "local-source-changes",
      files: ["code.ts"],
      published: true,
    },
  ]);
  assert.equal(p.files.length, 0);
  // The host reverts its local edit: file contents stay identical, but the
  // skip set changed, so the approval previewed with the skip is stale.
  hot("checkout", "--", "code.ts");
  const clean = await repository.publishPlan(f);
  assert.deepEqual(clean.skipped, []);
  assert.equal(clean.files.length, 0);
  await assert.rejects(
    repository.publish(f, p.approval, { push: false }),
    /stale/i,
  );
});
test("publishing preserves the previous baseline for skipped plugins so subsequent exports do not report unapplied changes", async () => {
  const f = await fixture(),
    dir = path.join(f.home, "hot");
  await mkdir(dir);
  const hot = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  hot("init", "-q");
  hot("config", "user.name", "Test");
  hot("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "code.ts"), "one");
  hot("add", ".");
  hot("commit", "-qm", "one");
  const row = {
    id: "hot",
    enabled: true,
    status: "running",
    path: dir,
    installation: {
      identity: {
        kind: "git",
        remote: "https://example.invalid/hot.git",
        pluginPath: ".",
      },
      currentRevision: hot("rev-parse", "HEAD"),
    },
  };
  f.rows.push(row);
  // Publish revision A
  let p = await repository.publishPlan(f);
  await repository.publish(f, p.approval, { push: false });
  const revA = (
    await jsonOrNull(await safeFile(f.state, "baseline.json"))
  ).plugins.hot.revision;

  // Advance locally to revision B
  await writeFile(path.join(dir, "code.ts"), "two");
  hot("add", ".");
  hot("commit", "-qm", "two");
  row.installation.currentRevision = hot("rev-parse", "HEAD");

  // Dirty local checkout and publish while dirty
  await writeFile(path.join(dir, "code.ts"), "uncommitted");
  p = await repository.publishPlan(f);
  assert.equal(p.skipped[0]?.plugin, "hot");
  await repository.publish(f, p.approval, { push: false });

  // Baseline must preserve revision A, not unpublished revision B
  const baseline = await jsonOrNull(await safeFile(f.state, "baseline.json"));
  assert.equal(baseline.plugins.hot.revision, revA);

  // Reverting uncommitted edit allows clean export/preview without false conflicts
  hot("checkout", "--", "code.ts");
  const clean = await repository.publishPlan(f);
  assert.deepEqual(clean.skipped, []);
  assert.ok(clean.files.some((x) => x.path === "profile.json"));
});

