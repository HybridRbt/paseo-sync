import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exportProfile,
  assertRepositoryReady,
} from "../server/core/export.mjs";
import { writeJson } from "../server/core/files.mjs";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "paseo-export-"));
  const root = path.join(base, "repo"),
    home = path.join(base, "home"),
    state = path.join(base, "state");
  await Promise.all(
    [root, home, state].map((p) => mkdir(p, { recursive: true })),
  );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "core.fsmonitor", "false"]);
  await writeJson(path.join(home, "config.json"), {
    pluginsEnabled: true,
    daemon: { token: "private-daemon-token" },
  });
  await writeJson(path.join(home, "plugin-data/linear/credentials.json"), {
    key: "private-linear-token",
  });
  await writeJson(
    path.join(home, "plugin-settings/better-paseo/presentation.json"),
    { version: 1, values: { previewWrap: true } },
  );
  const rows = [
    {
      id: "better-paseo",
      enabled: true,
      status: "running",
      installation: {
        identity: {
          kind: "git",
          remote: "https://github.com/RoundRedDot/better-paseo",
          pluginPath: ".",
        },
        currentRevision: "a".repeat(40),
      },
    },
  ];
  return { root, home, state, adapter: { list: async () => rows }, rows };
}
test("export includes only portable sources and allowlisted settings, never credentials", async () => {
  const ctx = await fixture();
  const result = await exportProfile(ctx);
  assert.equal(result.plugins, 1);
  const text = await readFile(path.join(ctx.root, "profile.json"), "utf8");
  assert.ok(!text.includes(ctx.home));
  assert.ok(!text.includes("private-"));
  assert.equal(JSON.parse(text).settings.length, 1);
  const setting = await readFile(
    path.join(ctx.root, "settings/better-paseo/presentation.json"),
    "utf8",
  );
  assert.ok(!setting.includes("private-"));
});
test("export refuses unknown installation identity without creating a manifest", async () => {
  const ctx = await fixture();
  ctx.rows.push({ id: "mystery", enabled: true, path: "/tmp/unknown" });
  await assert.rejects(exportProfile(ctx), /untracked/i);
  await assert.rejects(readFile(path.join(ctx.root, "profile.json")));
});
test("repository guard refuses tracked work and commits behind upstream", async () => {
  const ctx = await fixture();
  const git = (...args) =>
    execFileSync("git", ["-C", ctx.root, ...args], { encoding: "utf8" }).trim();
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(ctx.root, "tracked"), "first");
  git("add", ".");
  git("commit", "-qm", "first");
  await writeFile(path.join(ctx.root, "tracked"), "changed");
  await assert.rejects(assertRepositoryReady(ctx.root), /uncommitted/i);
  git("checkout", "--", "tracked");
  const bare = path.join(path.dirname(ctx.root), "remote.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  git("remote", "add", "origin", bare);
  git("push", "-qu", "origin", "HEAD");
  const peer = path.join(path.dirname(ctx.root), "peer");
  execFileSync("git", ["clone", "-q", bare, peer]);
  execFileSync("git", ["-C", peer, "config", "core.fsmonitor", "false"]);
  const peerGit = (...args) =>
    execFileSync("git", ["-C", peer, ...args], { stdio: "pipe" });
  peerGit("config", "user.name", "Peer");
  peerGit("config", "user.email", "peer@example.invalid");
  await writeFile(path.join(peer, "tracked"), "peer");
  peerGit("commit", "-qam", "peer");
  peerGit("push", "-q");
  await assert.rejects(assertRepositoryReady(ctx.root), /behind|diverged/i);
});

test("export refuses unapplied additions, deletions and missing settings against baseline", async () => {
  const plugin = {
    id: "better-paseo",
    source: "git:https://github.com/RoundRedDot/better-paseo",
    revision: "a".repeat(40),
    enabled: true,
  };
  const extra = {
    id: "skills",
    source: "npm:@gpambrozio/paseo-skills",
    revision: "0.4.0",
    enabled: true,
  };
  const doc = {
    plugin: "better-paseo",
    document: "presentation",
    file: "settings/better-paseo/presentation.json",
  };
  for (const kind of [
    "addition",
    "deletion",
    "missing-setting",
    "new-setting",
    "deleted-setting",
  ]) {
    const ctx = await fixture();
    const value = { version: 1, values: { previewWrap: false } };
    const localValue = { version: 1, values: { previewWrap: true } };
    let manifest = {
      schemaVersion: 1,
      plugins: [plugin],
      settings: [doc],
      patches: [],
    };
    const previous = {
      schemaVersion: 1,
      plugins: { "better-paseo": plugin },
      settings: {
        [doc.file]: Buffer.from(JSON.stringify(localValue)).toString("base64"),
      },
    };
    if (kind === "addition") manifest.plugins.push(extra);
    if (kind === "deletion") {
      previous.plugins.skills = extra;
      ctx.rows.push({
        id: "skills",
        enabled: true,
        status: "running",
        installation: {
          identity: {
            kind: "npm",
            packageName: "@gpambrozio/paseo-skills",
            pluginPath: ".",
          },
          currentRevision: "0.4.0",
        },
      });
    }
    if (kind === "missing-setting") {
      await import("node:fs/promises").then((fs) =>
        fs.rm(
          path.join(ctx.home, "plugin-settings/better-paseo/presentation.json"),
        ),
      );
    }
    if (kind === "new-setting") previous.settings = {};
    if (kind === "deleted-setting") manifest.settings = [];
    await writeJson(path.join(ctx.root, "profile.json"), manifest);
    await writeJson(
      path.join(ctx.root, doc.file),
      kind === "addition" || kind === "deletion" ? localValue : value,
    );
    await writeJson(path.join(ctx.state, "baseline.json"), previous);
    const git = (...args) =>
      execFileSync("git", ["-C", ctx.root, ...args], { stdio: "pipe" });
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "-qm", "remote state");
    const before = await readFile(path.join(ctx.root, "profile.json"), "utf8");
    await assert.rejects(exportProfile(ctx), /unapplied/i, kind);
    assert.equal(
      await readFile(path.join(ctx.root, "profile.json"), "utf8"),
      before,
    );
  }
});
test("export refuses a committed Git HEAD that differs from installation provenance", async () => {
  const ctx = await fixture(),
    dir = path.join(ctx.home, "source");
  await mkdir(dir);
  const git = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "code.ts"), "one");
  git("add", ".");
  git("commit", "-qm", "one");
  ctx.rows[0].path = dir;
  ctx.rows[0].installation.currentRevision = git("rev-parse", "HEAD");
  await writeFile(path.join(dir, "code.ts"), "two");
  git("commit", "-qam", "two");
  await assert.rejects(exportProfile(ctx), /HEAD|revision|provenance/i);
  await assert.rejects(readFile(path.join(ctx.root, "profile.json")));
});
test("export refuses untracked Git runtime files as unrecorded local source", async () => {
  const ctx = await fixture(),
    dir = path.join(ctx.home, "source");
  await mkdir(dir);
  const git = (...a) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", dir, ...a], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "code.ts"), "one");
  git("add", ".");
  git("commit", "-qm", "one");
  ctx.rows[0].path = dir;
  ctx.rows[0].installation.currentRevision = git("rev-parse", "HEAD");
  await writeFile(path.join(dir, "extra.ts"), "local");
  await assert.rejects(exportProfile(ctx), /local source|untracked|changes/i);
});

test("after syncing an absent disabled plugin export preserves its intent, settings and patch without reading orphan data", async () => {
  const ctx = await fixture();
  ctx.rows.length = 0;
  const disabled = {
    id: "better-paseo",
    source: "npm:better-paseo",
    revision: "1.0.0",
    enabled: false,
  };
  const file = "settings/better-paseo/presentation.json";
  const setting = { version: 1, values: { previewWrap: false } };
  await writeJson(path.join(ctx.root, file), setting);
  const { digest } = await import("../server/core/files.mjs");
  const patchFile = "patches/disabled.json";
  await writeJson(path.join(ctx.root, patchFile), {
    schemaVersion: 1,
    plugin: disabled.id,
    revision: disabled.revision,
    files: [
      {
        path: "index.client.tsx",
        beforeSha256: digest("old"),
        afterSha256: digest("new"),
        find: "old",
        replace: "new",
        count: 1,
      },
    ],
  });
  const manifest = {
    schemaVersion: 1,
    plugins: [disabled],
    settings: [{ plugin: disabled.id, document: "presentation", file }],
    patches: [{ plugin: disabled.id, file: patchFile }],
  };
  await writeJson(path.join(ctx.root, "profile.json"), manifest);
  for (const args of [
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
    ["add", "."],
    ["commit", "-qm", "profile"],
  ])
    execFileSync("git", ["-C", ctx.root, ...args], { stdio: "pipe" });
  const { buildPlan, applyPlan, captureBaseline } = await import(
    "../server/core/sync.mjs"
  );
  const { loadProfile } = await import("../server/core/profile.mjs");
  const p = await buildPlan(ctx);
  await applyPlan(ctx, p.approval);
  await writeFile(
    path.join(ctx.home, "plugin-settings/better-paseo/presentation.json"),
    "unmanaged invalid orphan JSON",
  );
  await exportProfile(ctx);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(ctx.root, "profile.json"), "utf8")),
    manifest,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(ctx.root, file), "utf8")),
    setting,
  );
  await captureBaseline(ctx, await loadProfile(ctx.root));
});
