import { readdir, readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { gitRaw } from "./git.mjs";
import { safeFile, bytesOrNull, digest, atomicWrite } from "./files.mjs";

export const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
export const BUNDLE_MARKER = ".paseo-sync-bundle.json";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Bundles are committed and pushed to the profile repository, so files that
// commonly hold local credentials are never packaged, whatever a plugin's
// package.json "files" allowlist or ignore files say.
const SECRET_PATTERNS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[^/]+$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.(aws|ssh|gnupg)\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];
// Committed templates of environment files carry no secrets by convention.
const SECRET_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/;

export function isSecretPath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  if (SECRET_TEMPLATE.test(normalized)) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
}

const EXCLUDED_PATTERNS = [
  /(^|\/)\.git($|\/)/,
  /(^|\/)node_modules($|\/)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
  /(^|\/)\.cache($|\/)/,
  /\.log$/,
  /(^|\/)\.paseo-sync-bundle\.json$/,
];

export function shouldExclude(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function safeArchiveRelativePath(entryPath, targetDir) {
  const rawSegments = String(entryPath).split(/[\\/]+/);
  const normalized = path.normalize(entryPath).replace(/^[\\/]+/, "");
  const normSegments = normalized.split(/[\\/]+/);
  if (
    !entryPath ||
    path.isAbsolute(entryPath) ||
    /^[a-zA-Z]:/.test(entryPath) ||
    rawSegments.includes("..") ||
    normSegments.includes("..")
  ) {
    throw new Error(`Path traversal detected in archive entry: ${entryPath}`);
  }
  const resolved = path.resolve(targetDir, normalized);
  const resolvedTarget = path.resolve(targetDir);
  if (resolved !== resolvedTarget && !resolved.startsWith(resolvedTarget + path.sep)) {
    throw new Error(`Path traversal detected outside target directory: ${entryPath}`);
  }
  return resolved;
}

/**
 * Builds a valid ustar tar header buffer (512 bytes). Only the executable
 * bit is meaningful in `mode`: it is normalized to 0755 or 0644 so archives
 * stay deterministic across umasks.
 *
 * ustar splits paths > 100 bytes into a prefix (<= 155 bytes) and short name
 * (<= 100 bytes) at a slash boundary. The boundaries must be validated by
 * UTF-8 byte length (not character count) so multibyte characters are never
 * silently truncated.
 */
export function buildTarHeader(name, size, typeflag = "0", mode = 0o644) {
  const buf = Buffer.alloc(512);

  // name (100) and prefix (155) fields in ustar format
  const nameBuf = Buffer.from(name, "utf8");
  if (nameBuf.length <= 100) {
    nameBuf.copy(buf, 0);
  } else {
    let splitIdx = -1;
    for (let i = name.length - 1; i >= 0; i--) {
      if (name[i] === "/") {
        const prefix = name.slice(0, i);
        const shortName = name.slice(i + 1);
        if (
          prefix.length > 0 &&
          shortName.length > 0 &&
          Buffer.byteLength(prefix, "utf8") <= 155 &&
          Buffer.byteLength(shortName, "utf8") <= 100
        ) {
          splitIdx = i;
          break;
        }
      }
    }
    if (splitIdx > 0) {
      const prefix = name.slice(0, splitIdx);
      const shortName = name.slice(splitIdx + 1);
      Buffer.from(shortName, "utf8").copy(buf, 0);
      Buffer.from(prefix, "utf8").copy(buf, 345);
    } else {
      throw new Error(`Path too long for tar header: ${name}`);
    }
  }

  // mode (8 bytes octal)
  const normalizedMode = mode & 0o111 ? 0o755 : 0o644;
  buf.write(normalizedMode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  // uid (8)
  buf.write("0000000\0", 108, 8, "ascii");
  // gid (8)
  buf.write("0000000\0", 116, 8, "ascii");
  // size (12 bytes octal: 11 octal digits + NUL)
  const sizeOctal = size.toString(8).padStart(11, "0") + "\0";
  buf.write(sizeOctal, 124, 12, "ascii");
  // mtime (12 bytes octal: 0 for determinism)
  buf.write("00000000000\0", 136, 12, "ascii");
  // chksum space placeholder (8 bytes space)
  buf.fill(0x20, 148, 156);
  // typeflag (1)
  buf.write(typeflag, 156, 1, "ascii");
  // magic (6: "ustar\0")
  buf.write("ustar\0", 257, 6, "ascii");
  // version (2: "00")
  buf.write("00", 263, 2, "ascii");
  // uname (32)
  buf.write("paseo\0", 265, 32, "ascii");
  // gname (32)
  buf.write("paseo\0", 297, 32, "ascii");

  // Compute checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += buf[i];
  }
  const chkOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
  buf.write(chkOctal, 148, 8, "ascii");

  return buf;
}

/**
 * Builds a deterministic tar buffer from a list of { name, content } entries.
 */
export function buildTarBuffer(entries) {
  // Sort entries deterministically by name
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const buffers = [];

  for (const entry of sorted) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content);
    const header = buildTarHeader(entry.name, content.length, "0", entry.mode);
    buffers.push(header);
    buffers.push(content);
    const remainder = content.length % 512;
    if (remainder > 0) {
      buffers.push(Buffer.alloc(512 - remainder));
    }
  }

  // Two 512-byte zero blocks at the end of tar archive
  buffers.push(Buffer.alloc(1024));

  return Buffer.concat(buffers);
}

/**
 * Parses entries from an uncompressed tar buffer.
 */
export function parseTarEntries(tarBuffer) {
  const entries = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // Check if end of archive (all zeros)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Read name (with optional prefix)
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) {
      name = `${prefix}/${name}`;
    }

    const sizeStr = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const modeStr = header.subarray(100, 108).toString("ascii").replace(/\0.*$/, "").trim();
    const mode = parseInt(modeStr, 8) || 0o644;
    const typeflag = String.fromCharCode(header[156]);

    offset += 512;
    const content = tarBuffer.subarray(offset, offset + size);
    entries.push({ name, size, mode, typeflag, content });

    const remainder = size % 512;
    offset += size + (remainder > 0 ? 512 - remainder : 0);
  }

  return entries;
}

/**
 * Recursively scans a directory for candidate files (built-in exclusions
 * applied, symbolic links never followed).
 */
async function scanFiles(baseDir, currentDir = "", fileList = []) {
  const fullDir = path.join(baseDir, currentDir);
  const items = await readdir(fullDir, { withFileTypes: true });

  // Sort items deterministically
  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    const relPath = currentDir ? `${currentDir}/${item.name}` : item.name;
    if (shouldExclude(relPath)) {
      continue;
    }

    if (item.isDirectory()) {
      await scanFiles(baseDir, relPath, fileList);
    } else if (item.isFile()) {
      fileList.push(relPath);
    }
  }

  return fileList;
}

/**
 * Translates one glob into a regex body: `*` and `?` stay within a path
 * segment, a leading or segment-wide `**​/` matches zero or more directories
 * and a trailing `/**` everything below. Each token is translated exactly
 * once, so generated regex text is never rewritten again.
 */
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const segmentStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (segmentStart && next === "/") {
          re += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (segmentStart && next === undefined) {
          re += ".*";
          i += 1;
          continue;
        }
        re += "[^/]*";
        i += 1;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

/**
 * npm "files" semantics: a pattern matches a file directly or through any of
 * its parent directories (so "dist" or "dist/" includes everything below it).
 */
export function matchPattern(p, pat) {
  let pattern = pat
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
  const dirOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  if (!pattern) return false;
  const re = new RegExp("^" + globToRegex(pattern) + "$");
  const parts = p.split("/");
  for (let n = parts.length - (dirOnly ? 1 : 0); n >= 1; n--) {
    if (re.test(parts.slice(0, n).join("/"))) return true;
  }
  return false;
}

export function isPkgFileMatch(relPath, patterns) {
  const normalized = relPath.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (
    base === "package.json" ||
    base === "paseo-plugin.json" ||
    /^README(\..+)?$/i.test(base) ||
    /^LICENSE(\..+)?$/i.test(base) ||
    /^LICENCE(\..+)?$/i.test(base)
  ) {
    return true;
  }
  let matched = false;
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    if (raw.startsWith("!")) {
      const pat = raw.slice(1);
      if (matchPattern(normalized, pat)) return false;
    } else {
      if (matchPattern(normalized, raw)) matched = true;
    }
  }
  return matched;
}

/**
 * Parses .gitignore / .npmignore text into ordered rules (last match wins).
 */
export function parseIgnore(text) {
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\")) {
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    // A slash at the start or in the middle anchors the pattern to the root.
    const anchored = line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    rules.push({
      negate,
      dirOnly,
      re: new RegExp("^" + (anchored ? "" : "(?:.*/)?") + globToRegex(line) + "$"),
    });
  }
  return rules;
}

export function isIgnored(relPath, rules) {
  const parts = relPath.replace(/\\/g, "/").split("/");
  for (let n = 1; n <= parts.length; n++) {
    const sub = parts.slice(0, n).join("/");
    const isDir = n < parts.length;
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(sub)) ignored = !rule.negate;
    }
    // A file below an ignored directory cannot be re-included (git semantics).
    if (ignored) return true;
  }
  return false;
}

async function textOrNull(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Files Git would publish from this directory (tracked plus untracked but
 * not ignored, honoring nested and global excludes), or null when the
 * directory is not a usable Git work tree.
 */
async function gitPublishable(sourceDir) {
  try {
    const out = await gitRaw(
      sourceDir,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    );
    const listed = new Set(out.split("\0").filter(Boolean));
    // An ignored plugin directory inside an unrelated parent repository
    // would list nothing; fall back to the plugin's own ignore file then.
    return listed.has("paseo-plugin.json") ? listed : null;
  } catch {
    return null;
  }
}

/**
 * Packaging policy. Secrets are always excluded. A nonempty package.json
 * "files" allowlist selects the published files; without one, an absent
 * allowlist never means "publish the whole checkout": .npmignore applies
 * when present, otherwise Git's ignore rules.
 */
export async function selectBundleFiles(sourceDir, relFiles) {
  const candidates = relFiles.filter((f) => !isSecretPath(f));
  let pkgFiles = null;
  try {
    const pkg = JSON.parse(
      await readFile(path.join(sourceDir, "package.json"), "utf8"),
    );
    if (Array.isArray(pkg?.files) && pkg.files.length > 0) {
      pkgFiles = pkg.files;
    }
  } catch {}
  if (pkgFiles) return candidates.filter((f) => isPkgFileMatch(f, pkgFiles));
  const npmignore = await textOrNull(path.join(sourceDir, ".npmignore"));
  if (npmignore !== null) {
    const rules = parseIgnore(npmignore);
    return candidates.filter((f) => !isIgnored(f, rules));
  }
  const listed = await gitPublishable(sourceDir);
  if (listed) return candidates.filter((f) => listed.has(f));
  const gitignore = await textOrNull(path.join(sourceDir, ".gitignore"));
  if (gitignore !== null) {
    const rules = parseIgnore(gitignore);
    return candidates.filter((f) => !isIgnored(f, rules));
  }
  return candidates;
}

/**
 * Fingerprints the files of an installed bundle directory: name -> sha256.
 * Uses the same built-in exclusions as packing (the marker is excluded).
 */
export async function fingerprintDirectory(dir) {
  const files = {};
  for (const relPath of await scanFiles(dir)) {
    files[relPath] = sha256(await readFile(path.join(dir, relPath)));
  }
  return files;
}

/**
 * Packs a plugin directory into a deterministic .tar.gz buffer.
 */
export async function packPluginDirectory(sourceDir, options = {}) {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const relFiles = await selectBundleFiles(sourceDir, await scanFiles(sourceDir));

  let totalSize = 0;
  const entries = [];
  const files = {};

  for (const relPath of relFiles) {
    const fullPath = path.join(sourceDir, relPath);
    const content = await readFile(fullPath);
    totalSize += content.length;
    if (totalSize > maxSizeBytes) {
      throw new Error(`Bundle size exceeds limit (${maxSizeBytes} bytes)`);
    }
    const { mode } = await stat(fullPath);
    entries.push({ name: relPath, content, mode });
    files[relPath] = sha256(content);
  }

  const tarBuffer = buildTarBuffer(entries);
  // Deterministic gzip with mtime: 0
  const gzipped = zlib.gzipSync(tarBuffer, { mtime: 0, level: 9 });

  return {
    buffer: gzipped,
    sha256: sha256(gzipped),
    files,
    fileCount: entries.length,
    uncompressedBytes: totalSize,
    compressedBytes: gzipped.length,
  };
}

/**
 * Unpacks a .tar.gz buffer or file into a target directory with strict path
 * safety. Returns the extracted files' fingerprints (name -> sha256).
 */
export async function unpackBundle(archiveBufferOrPath, targetDir, options = {}) {
  const buffer = Buffer.isBuffer(archiveBufferOrPath)
    ? archiveBufferOrPath
    : await readFile(archiveBufferOrPath);

  const tarBuffer = zlib.gunzipSync(buffer);
  const entries = parseTarEntries(tarBuffer);

  await mkdir(targetDir, { recursive: true });

  let fileCount = 0;
  const files = {};
  for (const entry of entries) {
    if (entry.typeflag === "5" || entry.name.endsWith("/")) {
      // Directory entry
      const safeDir = safeArchiveRelativePath(entry.name, targetDir);
      await mkdir(safeDir, { recursive: true });
      continue;
    }

    const safeFile = safeArchiveRelativePath(entry.name, targetDir);
    await mkdir(path.dirname(safeFile), { recursive: true });
    const executable = (entry.mode & 0o111) !== 0;
    await writeFile(safeFile, entry.content, {
      mode: executable ? 0o755 : 0o644,
    });
    if (executable && process.platform !== "win32") await chmod(safeFile, 0o755);
    files[entry.name.replace(/\\/g, "/")] = sha256(entry.content);
    fileCount++;
  }

  return {
    fileCount,
    files,
    extractedTo: targetDir,
  };
}

/**
 * Resolves a bundle archive buffer matching a descriptor's declared revision:
 * (1) checks local state cache: ctx.state/bundles/${id}-${revision}.tar.gz
 * (2) checks profile repository root: ctx.root/${source.slice(7)}
 * (3) reconstructs and verifies from plugin directory if provided
 * Populates ctx.state cache when an archive is retrieved or reconstructed.
 */
export async function resolveBundleArchive(ctx, target, pluginPath = null) {
  if (ctx?.state && target?.id && target?.revision) {
    const cachedFile = path.join(
      ctx.state,
      "bundles",
      `${target.id}-${target.revision}.tar.gz`,
    );
    const cachedRaw = await bytesOrNull(cachedFile);
    if (cachedRaw && digest(cachedRaw) === target.revision) {
      return cachedRaw;
    }
  }
  if (ctx?.root && target?.source?.startsWith("bundle:") && target?.revision) {
    const bundleRel = target.source.slice(7);
    try {
      const bundlePath = await safeFile(ctx.root, bundleRel);
      const repoRaw = await bytesOrNull(bundlePath);
      if (repoRaw && digest(repoRaw) === target.revision) {
        if (ctx.state && target.id) {
          const cachedFile = path.join(
            ctx.state,
            "bundles",
            `${target.id}-${target.revision}.tar.gz`,
          );
          await mkdir(path.dirname(cachedFile), { recursive: true });
          await atomicWrite(cachedFile, repoRaw);
        }
        return repoRaw;
      }
    } catch {}
  }
  if (pluginPath && target?.revision) {
    try {
      const packed = await packPluginDirectory(pluginPath);
      if (packed.sha256 === target.revision) {
        if (ctx?.state && target?.id) {
          const cachedFile = path.join(
            ctx.state,
            "bundles",
            `${target.id}-${target.revision}.tar.gz`,
          );
          await mkdir(path.dirname(cachedFile), { recursive: true });
          await atomicWrite(cachedFile, packed.buffer);
        }
        return packed.buffer;
      }
    } catch {}
  }
  return null;
}
