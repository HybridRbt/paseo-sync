import path from "node:path";
import os from "node:os";
import { lstat, realpath, readdir, readFile } from "node:fs/promises";
import { git } from "./core/git.mjs";
import { safeFile, jsonOrNull, writeJson } from "./core/files.mjs";
import { validateProfile } from "./core/profile.mjs";

export function syncStateRoot() {
  return (
    process.env.PASEO_SYNC_STATE ??
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PaseoSync")
      : path.join(os.homedir(), ".local", "state", "paseo-sync"))
  );
}
export function commonRoots(home = os.homedir()) {
  return [
    "Documents",
    "Projects",
    "projects",
    "Developer",
    "src",
    "paseo-profile",
  ].map((name) => path.join(home, name));
}
function publicUrl(value) {
  if (!value || /[\s\x00-\x1f]/.test(value)) return null;
  if (
    /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes("/../")
  )
    return value;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
      ? value
      : null;
  } catch {
    return null;
  }
}
async function candidate(root, source, daemonHome) {
  if (!path.isAbsolute(root)) return null;
  try {
    if (
      !(await lstat(root)).isDirectory() ||
      (await lstat(root)).isSymbolicLink()
    )
      return null;
    const checkout = await realpath(root);
    if (daemonHome) {
      const rel = path.relative(daemonHome, checkout);
      if (
        rel === "" ||
        (!rel.startsWith(".." + path.sep) &&
          rel !== ".." &&
          !path.isAbsolute(rel))
      )
        return null;
    }
    const profileFile = await safeFile(checkout, "profile.json");
    const info = await lstat(profileFile);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
    validateProfile(JSON.parse(await readFile(profileFile, "utf8")));
    const marker = await jsonOrNull(
      await safeFile(checkout, "paseo-plugin.json"),
    );
    if (marker?.id === "paseo-sync") return null;
    if (
      (await realpath(await git(checkout, "rev-parse", "--show-toplevel"))) !==
      checkout
    )
      return null;
    let fetch = "",
      pushes = [];
    try {
      fetch = await git(checkout, "remote", "get-url", "origin");
    } catch {
      /* No origin is supported. */
    }
    if (fetch) {
      try {
        pushes = (
          await git(checkout, "remote", "get-url", "--push", "--all", "origin")
        ).split("\n");
      } catch {
        /* Display read failure below. */
      }
    }
    const repositoryUrl = publicUrl(fetch),
      pushUrl = pushes.length === 1 ? publicUrl(pushes[0]) : null;
    return {
      checkout,
      repositoryUrl,
      pushUrl,
      remoteWarning: !!fetch && (!repositoryUrl || !pushUrl),
      source,
    };
  } catch {
    return null;
  }
}
export async function rememberRepository(historyFile, checkout) {
  let previous;
  try {
    previous = await jsonOrNull(historyFile);
  } catch {
    previous = [];
  }
  const paths = Array.isArray(previous)
    ? previous.filter((p) => typeof p === "string" && path.isAbsolute(p))
    : [];
  await writeJson(
    historyFile,
    [checkout, ...paths.filter((p) => p !== checkout)].slice(0, 20),
  );
}
export async function discoverRepositories({
  checkout = "",
  daemonHome,
  roots = commonRoots(),
  historyFile = path.join(syncStateRoot(), "connections.json"),
  maxDirectories = 1500,
  maxDepth = 6,
  maxMs = 3000,
} = {}) {
  const candidates = [],
    seen = new Set(),
    deadline = Date.now() + maxMs;
  let limited = false,
    savedInvalid = false,
    scanned = 0;
  const add = async (p, source) => {
    const c = await candidate(p, source, daemonHome);
    if (c && !seen.has(c.checkout)) {
      seen.add(c.checkout);
      candidates.push(c);
    }
    return c;
  };
  if (checkout) {
    const saved = await add(checkout, "saved");
    if (saved)
      return { candidates, selected: saved, savedInvalid, limited, scanned };
    savedInvalid = true;
  }
  let history = [];
  try {
    const h = await jsonOrNull(historyFile);
    if (Array.isArray(h)) history = h.slice(0, 20);
  } catch {
    /* Corrupt history cannot block manual setup. */
  }
  for (const p of history) if (typeof p === "string") await add(p, "history");
  const queue = roots.map((root) => ({ root, depth: 0 }));
  while (queue.length) {
    if (scanned >= maxDirectories || Date.now() >= deadline) {
      limited = true;
      break;
    }
    const { root, depth } = queue.shift();
    scanned++;
    try {
      const s = await lstat(root);
      if (s.isSymbolicLink() || !s.isDirectory()) continue;
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.some((e) => e.name === "profile.json" && e.isFile()))
        await add(root, "search");
      // Do not descend into repository internals or bulky generated directories.
      if (depth < maxDepth)
        for (const e of entries) {
          if (
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            ![
              "node_modules",
              "vendor",
              "dist",
              "build",
              "Library",
              "Applications",
            ].includes(e.name)
          )
            queue.push({ root: path.join(root, e.name), depth: depth + 1 });
        }
    } catch {
      /* Missing or inaccessible directories are normal. */
    }
  }
  return {
    candidates,
    selected: candidates.length === 1 && !limited ? candidates[0] : null,
    savedInvalid,
    limited,
    scanned,
  };
}
