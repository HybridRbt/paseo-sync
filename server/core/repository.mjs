import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  safeFile,
  bytesOrNull,
  jsonOrNull,
  objectHash,
  atomicWrite,
  relativeName,
  writeJson,
} from "./files.mjs";
import { exportProfile } from "./export.mjs";
import { loadProfile } from "./profile.mjs";
import { captureBaseline } from "./sync.mjs";
import { withOperation } from "./lock.mjs";
import { git } from "./git.mjs";
export { git } from "./git.mjs";
function validUrl(url) {
  if (typeof url !== "string" || /[\s\x00-\x1f]/.test(url))
    throw new Error("Invalid repository URL");
  if (
    /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(url) &&
    !url.includes("/../")
  )
    return;
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw new Error(
      "Repository URL must use HTTPS without credentials or git@host:path",
    );
}
export async function cleanRepository(root) {
  const actual = await realpath(root),
    top = await git(root, "rev-parse", "--show-toplevel");
  if ((await realpath(top)) !== actual)
    throw new Error("Checkout must be the repository root");
  if ((await git(root, "status", "--porcelain")).length)
    throw new Error(
      "Repository has uncommitted or untracked changes; review before continuing.",
    );
  if (!(await git(root, "branch", "--show-current")))
    throw new Error("Detached checkout requires a branch");
  return git(root, "rev-parse", "HEAD");
}
export async function prepareRepository(root, url) {
  if (!path.isAbsolute(root)) throw new Error("Checkout path must be absolute");
  let exists = true;
  try {
    if ((await lstat(root)).isSymbolicLink())
      throw new Error("Symlink checkout refused");
  } catch (e) {
    if (e.code === "ENOENT") exists = false;
    else throw e;
  }
  if (!exists) {
    validUrl(url);
    await mkdir(path.dirname(root), { recursive: true });
    await git(path.dirname(root), "clone", "--", url, root);
  }
  await cleanRepository(root);
  const remotes = await git(root, "remote");
  if (remotes.split("\n").includes("origin")) {
    await git(root, "fetch", "--no-tags", "origin");
    const up = await git(
      root,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
    if (!up.startsWith("origin/")) throw new Error("Upstream must be origin");
    await git(root, "merge", "--ff-only", up);
  }
  return { ready: true, commit: await cleanRepository(root) };
}
async function exportSnapshot(ctx) {
  const head = await cleanRepository(ctx.root),
    remotes = await git(ctx.root, "remote");
  let origin = null,
    upstream = null,
    pushUrl = null;
  if (remotes.split("\n").includes("origin")) {
    origin = await git(ctx.root, "remote", "get-url", "origin");
    if (/^https?:\/\/[^/]*@/i.test(origin))
      throw new Error(
        "Origin URL contains credentials; use a credential helper instead.",
      );
    const pushUrls = (
      await git(ctx.root, "remote", "get-url", "--push", "--all", "origin")
    )
      .split("\n")
      .filter(Boolean);
    if (pushUrls.length !== 1)
      throw new Error("Exactly one reviewed push URL is required");
    pushUrl = pushUrls[0];
    if (/^https?:\/\/[^/]*@/i.test(pushUrl))
      throw new Error("Push URL contains credentials; use a credential helper");
    await git(ctx.root, "fetch", "--no-tags", "origin");
    const up = await git(
      ctx.root,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
    upstream = up;
    if (!up.startsWith("origin/")) throw new Error("Upstream must be origin");
    const counts = (
      await git(ctx.root, "rev-list", "--left-right", "--count", `HEAD...${up}`)
    )
      .split(/\s+/)
      .map(Number);
    if (counts[1] > 0)
      throw new Error(
        "Repository behind or diverged; pull and reconcile before publishing",
      );
  }
  const temp = await mkdtemp(path.join(tmpdir(), "paseo-sync-export-"));
  try {
    await git(temp, "init", "-q");
    const old = await jsonOrNull(await safeFile(ctx.root, "profile.json"));
    if (old) {
      const loaded = await loadProfile(ctx.root);
      for (const file of [
        "profile.json",
        ...loaded.manifest.settings.map((x) => x.file),
        ...loaded.manifest.patches.map((x) => x.file),
      ])
        await atomicWrite(
          await safeFile(temp, file),
          await bytesOrNull(await safeFile(ctx.root, file)),
        );
    }
    await exportProfile({ ...ctx, root: temp });
    const loaded = await loadProfile(temp);
    const files = [];
    for (const file of [
      "profile.json",
      ...loaded.manifest.settings.map((x) => x.file),
      ...loaded.manifest.patches.map((x) => x.file),
    ].sort()) {
      relativeName(file);
      const before = await bytesOrNull(await safeFile(ctx.root, file)),
        after = await bytesOrNull(await safeFile(temp, file));
      if (!before?.equals(after))
        files.push({
          path: file,
          before: before?.toString("utf8") ?? null,
          after: after.toString("utf8"),
        });
    }
    return {
      head,
      origin,
      upstream,
      pushUrl,
      files,
      _baseline: await captureBaseline(ctx, loaded),
      approval: objectHash({ head, origin, pushUrl, upstream, files }),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function publishPlan(ctx) {
  const { _baseline, ...preview } = await exportSnapshot(ctx);
  return preview;
}
export async function publish(ctx, approval, { push = true } = {}) {
  return withOperation(ctx, async () => {
    const p = await exportSnapshot(ctx);
    if (p.approval !== approval) throw new Error("Publish preview is stale");
    if (push && !p.origin)
      throw new Error("Publishing requires an origin remote");
    if (p.files.length) {
      for (const file of p.files)
        await atomicWrite(await safeFile(ctx.root, file.path), file.after);
      const names = p.files.map((x) => x.path);
      await git(ctx.root, "add", "--", ...names);
      await git(
        ctx.root,
        "commit",
        "--only",
        "-m",
        "chore: publish Paseo profile",
        "--",
        ...names,
      );
    }
    const commit = await git(ctx.root, "rev-parse", "HEAD");
    await writeJson(await safeFile(ctx.state, "baseline.json"), p._baseline);
    if (push)
      await git(
        ctx.root,
        "push",
        "--",
        p.pushUrl,
        `HEAD:refs/heads/${p.upstream.slice(7)}`,
      );
    return { committed: p.files.length > 0, pushed: push, commit };
  });
}
