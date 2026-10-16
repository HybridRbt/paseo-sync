import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
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
export async function bytesOrNull(file) {
  try {
    return await readFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function jsonOrNull(file) {
  const data = await bytesOrNull(file);
  return data === null ? null : JSON.parse(data.toString("utf8"));
}
export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
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
