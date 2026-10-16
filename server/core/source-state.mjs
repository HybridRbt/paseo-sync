import path from "node:path";
import { git, gitRaw } from "./git.mjs";
import { bytesOrNull, safeFile, digest, objectHash } from "./files.mjs";
export async function sourceState(row, profile) {
  if (row.installation?.identity.kind !== "git") return null;
  const head = await git(row.path, "rev-parse", "HEAD");
  const status = await gitRaw(
    row.path,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  );
  const top = await git(row.path, "rev-parse", "--show-toplevel");
  const allowed = new Map();
  for (const b of profile.patches.filter((b) => b.plugin === row.id))
    for (const f of b.data.files) {
      const name = path
        .relative(top, path.join(row.path, ...f.path.split("/")))
        .split(path.sep)
        .join("/");
      const raw = await bytesOrNull(await safeFile(row.path, f.path));
      if (raw !== null && digest(raw) === f.afterSha256)
        allowed.set(name, true);
    }
  const changed = [];
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const mode = entry.slice(0, 2),
      name = entry.slice(3);
    if (mode !== " M" || !allowed.has(name)) changed.push(name);
    if (/[RC]/.test(mode)) {
      i++;
      if (parts[i]) changed.push(parts[i]);
    }
  }
  const clean =
    head === row.installation.currentRevision && changed.length === 0;
  return { clean, head, statusHash: objectHash(status), changed };
}
