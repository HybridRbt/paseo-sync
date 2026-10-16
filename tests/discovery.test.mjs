import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverRepositories,
  rememberRepository,
} from "../server/discovery.mjs";
const git = (root, ...args) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    stdio: "pipe",
  })
    .toString()
    .trim();
async function fixture() {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "paseo-find-")),
  );
  const home = path.join(base, "home");
  await mkdir(home);
  return {
    base,
    home,
    historyFile: path.join(base, "history.json"),
    roots: [home],
  };
}
async function repo(root, origin = "https://github.com/example/profile.git") {
  await mkdir(root, { recursive: true });
  git(root, "init", "-q");
  await writeFile(
    path.join(root, "profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [],
      settings: [],
      patches: [],
    }),
  );
  if (origin) git(root, "remote", "add", "origin", origin);
  return root;
}
test("saved valid checkout wins over other candidates and discovery does not write", async () => {
  const f = await fixture();
  const saved = await repo(path.join(f.home, "saved")),
    other = await repo(path.join(f.home, "other"));
  const before = await readdir(f.base);
  const r = await discoverRepositories({ ...f, checkout: saved });
  assert.equal(r.selected.checkout, saved);
  assert.equal(
    r.selected.repositoryUrl,
    "https://github.com/example/profile.git",
  );
  assert.deepEqual(await readdir(f.base), before);
  assert.notEqual(r.selected.checkout, other);
});
test("unique nested profile is selected but multiple valid repositories require a choice", async () => {
  const f = await fixture();
  const a = await repo(path.join(f.home, "Projects", "nested", "profile"));
  let r = await discoverRepositories(f);
  assert.equal(r.selected.checkout, a);
  await repo(path.join(f.home, "second"));
  r = await discoverRepositories(f);
  assert.equal(r.selected, null);
  assert.equal(r.candidates.length, 2);
});
test("invalid saved path is reported, invalid profiles and plugin source are not candidates", async () => {
  const f = await fixture();
  const bad = await repo(path.join(f.home, "bad"));
  await writeFile(path.join(bad, "profile.json"), "{}");
  const source = await repo(path.join(f.home, "source"));
  await writeFile(
    path.join(source, "paseo-plugin.json"),
    ' {"id":"paseo-sync"}',
  );
  const r = await discoverRepositories({
    ...f,
    checkout: path.join(f.home, "missing"),
  });
  assert.equal(r.selected, null);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.savedInvalid, true);
});
test("URLs with credentials or query secrets are withheld, safe push URL differences displayed", async () => {
  const f = await fixture();
  const root = await repo(
    path.join(f.home, "profile"),
    "https://user:secret@github.com/example/profile.git?token=secret",
  );
  git(
    root,
    "remote",
    "set-url",
    "--push",
    "origin",
    "git@github.com:example/target.git",
  );
  const r = await discoverRepositories({ ...f, checkout: root });
  assert.equal(r.selected.repositoryUrl, null);
  assert.equal(r.selected.pushUrl, "git@github.com:example/target.git");
  assert.equal(r.selected.remoteWarning, true);
  assert.ok(!JSON.stringify(r).includes("secret"));
});
test("history finds an arbitrary checkout outside common roots and missing origin stays null", async () => {
  const f = await fixture();
  const root = await repo(path.join(f.base, "elsewhere"), null);
  await rememberRepository(f.historyFile, root);
  const r = await discoverRepositories(f);
  assert.equal(r.selected.checkout, root);
  assert.equal(r.selected.repositoryUrl, null);
  assert.equal(r.selected.source, "history");
});
test("scan is bounded and does not follow directory links", async (t) => {
  const f = await fixture();
  const outside = await repo(path.join(f.base, "outside"));
  try {
    await symlink(
      outside,
      path.join(f.home, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (e) {
    if (e.code === "EPERM") {
      t.skip("symlink privilege unavailable");
      return;
    }
    throw e;
  }
  await mkdir(path.join(f.home, "child"));
  const r = await discoverRepositories({ ...f, maxDirectories: 1 });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.limited, true);
});
