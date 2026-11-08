import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const objectHash = (value) => digest(canonical(value));
export const same = (a, b) => canonical(a) === canonical(b);
export function relativeName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    /[\\:\x00-\x1f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((x) => !x || x === ".." || x === ".")
  )
    throw new Error(`Unsafe relative path: ${JSON.stringify(name)}`);
  return name;
}
export async function safeFile(root, relative) {
  relativeName(relative);
  const resolved = path.resolve(root);
  if ((await lstat(resolved)).isSymbolicLink())
    throw new Error(`Symbolic link refused: ${resolved}`);
  // System ancestors such as macOS /var may be links. Canonicalize the root,
  // then refuse every link inside the managed boundary.
  const absoluteRoot = await realpath(resolved);
  let current = absoluteRoot;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symbolic link refused: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path.join(absoluteRoot, ...relative.split("/"));
}
// Windows briefly denies operations on files this plugin owns: reads collide
// with scanner or sibling-process handles, and a lock directory recreated
// right after its recursive delete is still delete-pending, failing the
// temp-file create and the rename with EPERM/EACCES/EBUSY until it settles.
// Retry those a few times with backoff; every other error propagates unchanged.
const windowsRetry = async (operation) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 5
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
};
export async function bytesOrNull(file, { retry = true } = {}) {
  try {
    // Called through fs.readFile, not the named import, so tests can stub it.
    const read = () => fs.readFile(file);
    // Best-effort probes of foreign plugin paths pass retry:false so an
    // inaccessible manifest fails fast instead of stalling a whole batch
    // preview with one full retry budget per miss.
    return await (retry ? windowsRetry(read) : read());
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function jsonOrNull(file, opts) {
  const data = await bytesOrNull(file, opts);
  if (data === null) return null;
  const text = data.toString("utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}
export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await windowsRetry(() =>
      writeFile(temporary, data, { mode: 0o600, flag: "wx" }),
    );
    await windowsRetry(() => fs.rename(temporary, file));
  } finally {
    await rm(temporary, { force: true });
  }
}
export const writeJson = (file, value) =>
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
export async function privateRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await safeFile(root, ".probe");
  return realpath(root);
}
