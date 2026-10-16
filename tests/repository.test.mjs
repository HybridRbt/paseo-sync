import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as repository from "../server/core/repository.mjs";
import { writeJson } from "../server/core/files.mjs";
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
