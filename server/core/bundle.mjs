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

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds a deterministic tar buffer from a list of { name, content } entries.
 */
export function buildTarBuffer(entries) {
  // Sort entries deterministically by UTF-16 code units (locale-independent)
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.name, b.name));
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

  // Sort items deterministically by UTF-16 code units (locale-independent)
  items.sort((a, b) => compareCodeUnits(a.name, b.name));

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

const POSIX_CHAR_CLASSES = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  ascii: "\\x00-\\x7F",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "\\x21-\\x2E\\x30-\\x7E",
  lower: "a-z",
  print: "\\x20-\\x2E\\x30-\\x7E",
  punct: "!\"#$%&'()*+,\\-.:;<=>?@[\\\\\\]^_`{|}~",
  space: "\\s",
  upper: "A-Z",
  word: "A-Za-z0-9_",
  xdigit: "0-9A-Fa-f",
};

function findClosingBracket(str, startIdx) {
  let j = startIdx + 1;
  if (j < str.length && (str[j] === "!" || str[j] === "^")) j++;
  if (j < str.length && str[j] === "]") j++;
  while (j < str.length) {
    if (str[j] === "/") return -1;
    if (str[j] === "\\" && j + 1 < str.length) {
      if (str[j + 1] === "/") return -1;
      j += 2;
      continue;
    }
    if (str[j] === "[" && str[j + 1] === ":") {
      const m = /^\[:[a-z]+:\]/.exec(str.slice(j));
      if (m) {
        j += m[0].length;
        continue;
      }
    }
    if (str[j] === "]") return j;
    j++;
  }
  return -1;
}

function scanCharacterClass(glob, startIdx, strict = false) {
  const endIdx = findClosingBracket(glob, startIdx);
  if (endIdx === -1) return null;
  let j = startIdx + 1;
  let negated = false;
  if (j < endIdx && (glob[j] === "!" || glob[j] === "^")) {
    negated = true;
    j++;
  }
  let body = "";
  if (j < endIdx && glob[j] === "]") {
    body += "\\]";
    j++;
  }
  while (j < endIdx) {
    if (glob[j] === "\\" && j + 1 <= endIdx) {
      const esc = glob[j + 1];
      body += "\\]^-[/".includes(esc) ? "\\" + esc : esc;
      j += 2;
      continue;
    }
    if (glob[j] === "[" && glob[j + 1] === ":") {
      const m = /^\[:([a-z]+):\]/.exec(glob.slice(j));
      if (m && POSIX_CHAR_CLASSES[m[1]]) {
        body += POSIX_CHAR_CLASSES[m[1]];
        j += m[0].length;
        continue;
      }
    }
    const ch = glob[j];
    body += ch === "[" ? "\\[" : ch === "^" ? "\\^" : ch;
    j++;
  }
  if (!body) return null;
  const regex = negated ? `[^/${body}]` : `(?!\\/)[${body}]`;
  try {
    new RegExp(regex);
    return { endIdx, regex };
  } catch {
    if (strict) {
      throw new Error(`Invalid character class in glob pattern: ${glob}`);
    }
    return null;
  }
}

function findFirstBrace(str, maxRangeItems = 256) {
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      const closeBracket = findClosingBracket(str, i);
      if (closeBracket !== -1) {
        i = closeBracket;
        continue;
      }
    }
    if (c !== "{") continue;

    let depth = 1;
    const commas = [];
    let k = i + 1;
    for (; k < str.length; k++) {
      const kc = str[k];
      if (kc === "\\") {
        k++;
        continue;
      }
      if (kc === "[") {
        const cb = findClosingBracket(str, k);
        if (cb !== -1) {
          k = cb;
          continue;
        }
      }
      if (kc === "{") {
        depth++;
      } else if (kc === "}") {
        depth--;
        if (depth === 0) break;
      } else if (kc === "," && depth === 1) {
        commas.push(k);
      }
    }
    if (depth !== 0) continue;

    const inner = str.slice(i + 1, k);
    if (commas.length > 0) {
      const parts = [];
      let last = i + 1;
      for (const commaIdx of commas) {
        parts.push(str.slice(last, commaIdx));
        last = commaIdx + 1;
      }
      parts.push(str.slice(last, k));
      return { openIdx: i, closeIdx: k, parts };
    }

    const rangeMatch = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const rawStep = rangeMatch[3] !== undefined ? Math.abs(Number(rangeMatch[3])) : 1;
      if (rawStep > 0) {
        const count = Math.floor(Math.abs(end - start) / rawStep) + 1;
        if (count <= maxRangeItems) {
          const dir = start <= end ? 1 : -1;
          const step = rawStep * dir;
          const padWidth =
            (rangeMatch[1].startsWith("0") && rangeMatch[1].length > 1) ||
            (rangeMatch[2].startsWith("0") && rangeMatch[2].length > 1) ||
            (rangeMatch[1].startsWith("-0") && rangeMatch[1].length > 2) ||
            (rangeMatch[2].startsWith("-0") && rangeMatch[2].length > 2)
              ? Math.max(rangeMatch[1].replace(/^-/, "").length, rangeMatch[2].replace(/^-/, "").length)
              : 0;
          const parts = [];
          for (let v = start; dir > 0 ? v <= end : v >= end; v += step) {
            if (padWidth > 0) {
              const sign = v < 0 ? "-" : "";
              parts.push(sign + String(Math.abs(v)).padStart(padWidth, "0"));
            } else {
              parts.push(String(v));
            }
          }
          return { openIdx: i, closeIdx: k, parts };
        }
      }
    }
  }
  return null;
}

export function expandBraces(pattern, maxExpansions = 256) {
  const results = [];
  const queue = [pattern];
  while (queue.length > 0) {
    const current = queue.shift();
    const match = findFirstBrace(current, maxExpansions);
    if (!match) {
      results.push(current);
      continue;
    }
    if (results.length + queue.length + match.parts.length - 1 > maxExpansions) {
      throw new Error(`Glob brace expansion exceeds limit: ${pattern}`);
    }
    const prefix = current.slice(0, match.openIdx);
    const suffix = current.slice(match.closeIdx + 1);
    for (const part of match.parts) {
      queue.push(prefix + part + suffix);
    }
  }
  return results;
}

function findExtglobGroup(glob, openParenIdx) {
  let depth = 1;
  const pipes = [];
  for (let k = openParenIdx + 1; k < glob.length; k++) {
    const kc = glob[k];
    if (kc === "\\") {
      k++;
      continue;
    }
    if (kc === "[") {
      const cb = findClosingBracket(glob, k);
      if (cb !== -1) {
        k = cb;
        continue;
      }
    }
    if (kc === "(") {
      depth++;
    } else if (kc === ")") {
      depth--;
      if (depth === 0) {
        const parts = [];
        let last = openParenIdx + 1;
        for (const pipeIdx of pipes) {
          parts.push(glob.slice(last, pipeIdx));
          last = pipeIdx + 1;
        }
        parts.push(glob.slice(last, k));
        return { closeIdx: k, parts };
      }
    } else if (kc === "|" && depth === 1) {
      pipes.push(k);
    }
  }
  return null;
}

/**
 * Translates one glob into a regex body: `*` and `?` stay within a path
 * segment, a leading or segment-wide `**​/` matches zero or more directories,
 * a trailing `/**` everything below, and `[...]` matches segment character
 * classes. Each token is translated once so generated regex text is never
 * rewritten again.
 */
function globToRegex(glob, options = {}) {
  const { extglob = false, strict = false } = options;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") {
      if (i + 1 < glob.length) {
        re += glob[++i].replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      } else {
        re += "\\\\";
      }
      continue;
    }
    if (
      extglob &&
      (c === "?" || c === "*" || c === "+" || c === "@" || c === "!") &&
      glob[i + 1] === "("
    ) {
      const group = findExtglobGroup(glob, i + 1);
      if (group) {
        const inner = group.parts
          .map((alt) => globToRegex(alt, options))
          .join("|");
        if (c === "!") {
          const restRegex = globToRegex(glob.slice(group.closeIdx + 1), options);
          re += `(?:(?!(?:${inner})${restRegex}$)[^/]*)${restRegex}`;
          return re;
        }
        const quant = c === "@" ? "" : c;
        re += `(?:${inner})${quant}`;
        i = group.closeIdx;
        continue;
      }
    }
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
    } else if (c === "[") {
      const cls = scanCharacterClass(glob, i, strict);
      if (cls) {
        re += cls.regex;
        i = cls.endIdx;
      } else {
        re += "\\[";
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

function isLiteralAllowlistFile(raw) {
  if (raw.endsWith("/")) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "*" || c === "?" || c === "[" || c === "{") return false;
    if ((c === "+" || c === "@" || c === "!") && raw[i + 1] === "(") return false;
  }
  return true;
}

function unescapeLiteralPath(raw) {
  return raw
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\\(.)/g, "$1");
}

/**
 * npm "files" semantics: a pattern matches a file directly or through any of
 * its parent directories (so "dist" or "dist/" includes everything below it).
 * Brace expansion, character classes, and extglobs are supported.
 */
export function matchPattern(p, pat) {
  const normalizedPath = p.replace(/\\/g, "/");
  const parts = normalizedPath.split("/");
  for (const expanded of expandBraces(pat)) {
    let pattern = expanded
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, "");
    const dirOnly = pattern.endsWith("/");
    pattern = pattern.replace(/\/+$/, "");
    if (!pattern) continue;
    const re = new RegExp(
      "^" + globToRegex(pattern, { extglob: true, strict: true }) + "$",
    );
    for (let n = parts.length - (dirOnly ? 1 : 0); n >= 1; n--) {
      if (re.test(parts.slice(0, n).join("/"))) return true;
    }
  }
  return false;
}

function evaluatePkgFileMatch(relPath, patterns) {
  const normalized = relPath.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (
    !normalized.includes("/") &&
    (base === "package.json" ||
      base === "paseo-plugin.json" ||
      // A bundle is a source snapshot rebuilt on the restore host, not an npm
      // tarball: lockfiles are build inputs ("npm ci" refuses to run without
      // one), so an npm-publish "files" allowlist must not drop them.
      base === "package-lock.json" ||
      base === "npm-shrinkwrap.json" ||
      /^README(\..+)?$/i.test(base) ||
      /^LICENSE(\..+)?$/i.test(base) ||
      /^LICENCE(\..+)?$/i.test(base))
  ) {
    return { matched: true, directLiteral: true };
  }
  let matched = false;
  let directLiteral = false;
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    if (raw.startsWith("!")) {
      const pat = raw.slice(1);
      if (matchPattern(normalized, pat)) {
        matched = false;
        directLiteral = false;
      }
    } else if (matchPattern(normalized, raw)) {
      matched = true;
      if (isLiteralAllowlistFile(raw) && unescapeLiteralPath(raw) === normalized) {
        directLiteral = true;
      }
    }
  }
  return { matched, directLiteral };
}

export function isPkgFileMatch(relPath, patterns) {
  return evaluatePkgFileMatch(relPath, patterns).matched;
}

/**
 * Parses .gitignore / .npmignore text into ordered rules (last match wins).
 */
export function parseIgnore(text) {
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "").replace(/\\(\s)$/, "$1");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\") && (line[1] === "#" || line[1] === "!")) {
      line = line.slice(1);
    }
    for (const expanded of expandBraces(line)) {
      let pat = expanded;
      const dirOnly = pat.endsWith("/");
      pat = pat.replace(/\/+$/, "");
      // A slash at the start or in the middle anchors the pattern to its directory.
      const anchored = pat.includes("/");
      pat = pat.replace(/^\/+/, "");
      if (!pat) continue;
      rules.push({
        negate,
        dirOnly,
        re: new RegExp("^" + (anchored ? "" : "(?:.*/)?") + globToRegex(pat) + "$"),
      });
    }
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

function isIgnoreControlFile(relPath) {
  return /(^|\/)\.(npm|git)ignore$/.test(relPath.replace(/\\/g, "/"));
}

async function textOrNull(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function loadDirectoryIgnoreRules(sourceDir, candidates) {
  const dirs = new Set([""]);
  for (const relPath of candidates) {
    const parts = relPath.replace(/\\/g, "/").split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  const dirRules = new Map();
  for (const dir of dirs) {
    const fullDir = dir ? path.join(sourceDir, dir) : sourceDir;
    const npmignore = await textOrNull(path.join(fullDir, ".npmignore"));
    if (npmignore !== null) {
      dirRules.set(dir, { kind: "npmignore", rules: parseIgnore(npmignore) });
      continue;
    }
    const gitignore = await textOrNull(path.join(fullDir, ".gitignore"));
    if (gitignore !== null) {
      dirRules.set(dir, { kind: "gitignore", rules: parseIgnore(gitignore) });
    }
  }
  return dirRules;
}

function hasAncestorNpmignore(relPath, dirRules) {
  if (dirRules.get("")?.kind === "npmignore") return true;
  const parts = relPath.replace(/\\/g, "/").split("/");
  for (let i = 1; i < parts.length; i++) {
    if (dirRules.get(parts.slice(0, i).join("/"))?.kind === "npmignore") {
      return true;
    }
  }
  return false;
}

export function isTreeIgnored(relPath, dirRules, startDepth = 0) {
  const parts = relPath.replace(/\\/g, "/").split("/");
  for (let n = Math.max(1, startDepth + 1); n <= parts.length; n++) {
    const isDir = n < parts.length;
    let ignored = false;
    for (let m = startDepth; m < n; m++) {
      const dir = m === 0 ? "" : parts.slice(0, m).join("/");
      const entry = dirRules.get(dir);
      if (!entry) continue;
      const relSub = parts.slice(m, n).join("/");
      for (const rule of entry.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(relSub)) ignored = !rule.negate;
      }
    }
    // A file below an ignored directory cannot be re-included.
    if (ignored) return true;
  }
  return false;
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
 * Packaging policy. Secrets and ignore control files are always excluded.
 * A package.json "files" allowlist (including an explicitly empty `[]` list,
 * which retains only root-level mandatory metadata files) selects the published
 * files while still honoring nested subdirectory ignore files below
 * directory/glob matches; without one, directory-scoped .npmignore / .gitignore
 * rules and Git's worktree exclude rules apply throughout the scanned tree.
 */
export async function selectBundleFiles(sourceDir, relFiles) {
  const candidates = relFiles.filter(
    (f) => !isSecretPath(f) && !isIgnoreControlFile(f),
  );
  const dirRules = await loadDirectoryIgnoreRules(sourceDir, candidates);

  let pkgFiles = null;
  try {
    const pkg = JSON.parse(
      await readFile(path.join(sourceDir, "package.json"), "utf8"),
    );
    if (Array.isArray(pkg?.files)) {
      pkgFiles = pkg.files;
    }
  } catch {}

  if (pkgFiles) {
    return candidates.filter((f) => {
      const { matched, directLiteral } = evaluatePkgFileMatch(f, pkgFiles);
      if (!matched) return false;
      if (directLiteral) return true;
      return !isTreeIgnored(f, dirRules, 1);
    });
  }

  const listed =
    dirRules.get("")?.kind === "npmignore"
      ? null
      : await gitPublishable(sourceDir);

  return candidates.filter((f) => {
    if (hasAncestorNpmignore(f, dirRules)) {
      return !isTreeIgnored(f, dirRules, 0);
    }
    if (listed) return listed.has(f);
    return !isTreeIgnored(f, dirRules, 0);
  });
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
 * When `options.patches` is provided, any file whose on-disk SHA-256 matches
 * a patch specification's `afterSha256` is restored in-memory to its verified
 * `beforeSha256` content so the synthesized archive represents the unpatched base.
 */
export async function packPluginDirectory(sourceDir, options = {}) {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const relFiles = await selectBundleFiles(sourceDir, await scanFiles(sourceDir));
  const patchByPath = new Map();
  if (Array.isArray(options.patches)) {
    for (const spec of options.patches) {
      if (spec && typeof spec.path === "string") {
        patchByPath.set(
          spec.path.replace(/\\/g, "/").replace(/^(\.\/)+/, ""),
          spec,
        );
      }
    }
  }

  let totalSize = 0;
  const entries = [];
  const files = {};

  for (const relPath of relFiles) {
    const fullPath = path.join(sourceDir, relPath);
    const { size, mode } = await stat(fullPath);
    const patchSpec = patchByPath.get(relPath);
    if (!patchSpec && totalSize + size > maxSizeBytes) {
      throw new Error(`Bundle size exceeds limit (${maxSizeBytes} bytes)`);
    }
    let content = await readFile(fullPath);
    let fileHash = sha256(content);
    if (
      patchSpec &&
      patchSpec.afterSha256 &&
      patchSpec.beforeSha256 &&
      fileHash === patchSpec.afterSha256
    ) {
      if (
        Buffer.isBuffer(patchSpec.beforeBytes) &&
        sha256(patchSpec.beforeBytes) === patchSpec.beforeSha256
      ) {
        content = patchSpec.beforeBytes;
        fileHash = patchSpec.beforeSha256;
      } else if (
        typeof patchSpec.replace === "string" &&
        typeof patchSpec.find === "string" &&
        patchSpec.replace.length > 0
      ) {
        const reversed = Buffer.from(
          content.toString("utf8").split(patchSpec.replace).join(patchSpec.find),
          "utf8",
        );
        if (sha256(reversed) === patchSpec.beforeSha256) {
          content = reversed;
          fileHash = patchSpec.beforeSha256;
        }
      }
    }
    totalSize += content.length;
    if (totalSize > maxSizeBytes) {
      throw new Error(`Bundle size exceeds limit (${maxSizeBytes} bytes)`);
    }
    entries.push({ name: relPath, content, mode });
    files[relPath] = fileHash;
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
export async function resolveBundleArchive(
  ctx,
  target,
  pluginPath = null,
  patches = [],
) {
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
      const packed = await packPluginDirectory(pluginPath, { patches });
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

/**
 * Resolves the matching base bundle archive for `target` and attaches `beforeBytes`
 * to any patch specification whose `beforeSha256` matches the entry in that archive.
 * This allows non-invertible patches (such as deletion patches with `replace: ""`)
 * to be reversed accurately when synthesizing or exporting bundle archives.
 */
export async function attachPatchOriginalBytes(ctx, target, patchSpecs) {
  if (!ctx || !target || !Array.isArray(patchSpecs) || patchSpecs.length === 0) {
    return patchSpecs;
  }
  try {
    const raw = await resolveBundleArchive(ctx, target);
    if (raw) {
      const tarEntries = new Map(
        parseTarEntries(zlib.gunzipSync(raw)).map((e) => [
          e.name.replace(/\\/g, "/").replace(/^(\.\/)+/, ""),
          e.content,
        ]),
      );
      for (const spec of patchSpecs) {
        if (!spec || typeof spec.path !== "string") continue;
        const normPath = spec.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
        const orig = tarEntries.get(normPath);
        if (orig && sha256(orig) === spec.beforeSha256) {
          spec.beforeBytes = orig;
        }
      }
    }
  } catch {}
  return patchSpecs;
}
