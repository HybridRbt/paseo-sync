import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

export const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

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
  const normalized = path.normalize(entryPath).replace(/^[\\/]+/, "");
  if (normalized.includes("..") || path.isAbsolute(entryPath)) {
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
 * Builds a valid ustar tar header buffer (512 bytes).
 */
export function buildTarHeader(name, size, typeflag = "0") {
  const buf = Buffer.alloc(512);

  // name (100)
  const nameBuf = Buffer.from(name, "utf8");
  if (nameBuf.length > 100) {
    // Prefix support for paths > 100 chars
    const lastSlash = name.lastIndexOf("/", 155);
    if (lastSlash > 0 && name.length - lastSlash - 1 <= 100) {
      const prefix = name.slice(0, lastSlash);
      const shortName = name.slice(lastSlash + 1);
      Buffer.from(shortName, "utf8").copy(buf, 0, 0, 100);
      Buffer.from(prefix, "utf8").copy(buf, 345, 0, 155);
    } else {
      throw new Error(`Path too long for tar header: ${name}`);
    }
  } else {
    nameBuf.copy(buf, 0);
  }

  // mode (8 bytes octal)
  buf.write("0000644\0", 100, 8, "ascii");
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
    const header = buildTarHeader(entry.name, content.length);
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
    const typeflag = String.fromCharCode(header[156]);

    offset += 512;
    const content = tarBuffer.subarray(offset, offset + size);
    entries.push({ name, size, typeflag, content });

    const remainder = size % 512;
    offset += size + (remainder > 0 ? 512 - remainder : 0);
  }

  return entries;
}

/**
 * Recursively scans a directory for files to pack.
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

    const fullPath = path.join(fullDir, item.name);
    if (item.isDirectory()) {
      await scanFiles(baseDir, relPath, fileList);
    } else if (item.isFile()) {
      fileList.push(relPath);
    }
  }

  return fileList;
}

export function matchPattern(p, pat) {
  if (pat.endsWith("/")) {
    return p.startsWith(pat) || p === pat.slice(0, -1);
  }
  if (!pat.includes("*")) {
    return p === pat;
  }
  const regexStr = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp("^" + regexStr + "$").test(p);
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
 * Packs a plugin directory into a deterministic .tar.gz buffer.
 */
export async function packPluginDirectory(sourceDir, options = {}) {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const relFiles = await scanFiles(sourceDir);

  let pkgFiles = null;
  try {
    const pkg = JSON.parse(
      await readFile(path.join(sourceDir, "package.json"), "utf8"),
    );
    if (Array.isArray(pkg?.files) && pkg.files.length > 0) {
      pkgFiles = pkg.files;
    }
  } catch {}

  let totalSize = 0;
  const entries = [];

  for (const relPath of relFiles) {
    if (pkgFiles && !isPkgFileMatch(relPath, pkgFiles)) {
      continue;
    }
    const content = await readFile(path.join(sourceDir, relPath));
    totalSize += content.length;
    if (totalSize > maxSizeBytes) {
      throw new Error(`Bundle size exceeds limit (${maxSizeBytes} bytes)`);
    }
    entries.push({ name: relPath, content });
  }

  const tarBuffer = buildTarBuffer(entries);
  // Deterministic gzip with mtime: 0
  const gzipped = zlib.gzipSync(tarBuffer, { mtime: 0, level: 9 });
  const sha256 = crypto.createHash("sha256").update(gzipped).digest("hex");

  return {
    buffer: gzipped,
    sha256,
    fileCount: entries.length,
    uncompressedBytes: totalSize,
    compressedBytes: gzipped.length,
  };
}

/**
 * Unpacks a .tar.gz buffer or file into a target directory with strict path safety.
 */
export async function unpackBundle(archiveBufferOrPath, targetDir, options = {}) {
  const buffer = Buffer.isBuffer(archiveBufferOrPath)
    ? archiveBufferOrPath
    : await readFile(archiveBufferOrPath);

  const tarBuffer = zlib.gunzipSync(buffer);
  const entries = parseTarEntries(tarBuffer);

  await mkdir(targetDir, { recursive: true });

  let fileCount = 0;
  for (const entry of entries) {
    if (entry.typeflag === "5" || entry.name.endsWith("/")) {
      // Directory entry
      const safeDir = safeArchiveRelativePath(entry.name, targetDir);
      await mkdir(safeDir, { recursive: true });
      continue;
    }

    const safeFile = safeArchiveRelativePath(entry.name, targetDir);
    await mkdir(path.dirname(safeFile), { recursive: true });
    await writeFile(safeFile, entry.content);
    fileCount++;
  }

  return {
    fileCount,
    extractedTo: targetDir,
  };
}
