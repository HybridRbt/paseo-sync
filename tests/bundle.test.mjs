import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  packPluginDirectory,
  unpackBundle,
  buildTarBuffer,
  parseTarEntries,
} from "../server/core/bundle.mjs";

test("packPluginDirectory packages files, ignores .git/node_modules/.DS_Store, and is deterministic", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-dst-"));
  try {
    // Regular plugin files
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "my-plugin", name: "My Plugin" }));
    await writeFile(path.join(src, "index.js"), "console.log('hello');");
    await mkdir(path.join(src, "assets"), { recursive: true });
    await writeFile(path.join(src, "assets/icon.png"), "fake-png-content");

    // Ignored items
    await mkdir(path.join(src, ".git"), { recursive: true });
    await writeFile(path.join(src, ".git/config"), "secret git config");
    await mkdir(path.join(src, "node_modules/dep"), { recursive: true });
    await writeFile(path.join(src, "node_modules/dep/index.js"), "dep code");
    await writeFile(path.join(src, ".DS_Store"), "apple junk");

    // Pack 1
    const p1 = await packPluginDirectory(src);
    assert.equal(typeof p1.sha256, "string");
    assert.equal(p1.sha256.length, 64);
    assert.ok(p1.buffer instanceof Buffer);
    assert.equal(p1.fileCount, 3);

    // Pack 2 (determinism)
    const p2 = await packPluginDirectory(src);
    assert.equal(p1.sha256, p2.sha256);
    assert.deepEqual(p1.buffer, p2.buffer);

    // Unpack
    const res = await unpackBundle(p1.buffer, dst);
    assert.equal(res.fileCount, 3);

    const pluginJson = await readFile(path.join(dst, "paseo-plugin.json"), "utf8");
    assert.deepEqual(JSON.parse(pluginJson), { id: "my-plugin", name: "My Plugin" });
    const indexJs = await readFile(path.join(dst, "index.js"), "utf8");
    assert.equal(indexJs, "console.log('hello');");
    const icon = await readFile(path.join(dst, "assets/icon.png"), "utf8");
    assert.equal(icon, "fake-png-content");

    // Verify ignored files do NOT exist
    let gitExists = false;
    try {
      await readFile(path.join(dst, ".git/config"));
      gitExists = true;
    } catch {}
    assert.equal(gitExists, false);

    let nmExists = false;
    try {
      await readFile(path.join(dst, "node_modules/dep/index.js"));
      nmExists = true;
    } catch {}
    assert.equal(nmExists, false);

    let dsExists = false;
    try {
      await readFile(path.join(dst, ".DS_Store"));
      dsExists = true;
    } catch {}
    assert.equal(dsExists, false);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("unpackBundle rejects directory traversal in tar headers", async () => {
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-traversal-"));
  try {
    // Manually create a tar archive containing a traversal path "../escape.txt"
    const maliciousTar = buildTarBuffer([
      { name: "../escape.txt", content: Buffer.from("attack") }
    ]);
    const gzipped = zlib.gzipSync(maliciousTar);

    await assert.rejects(
      async () => {
        await unpackBundle(gzipped, dst);
      },
      {
        message: /Path traversal detected/,
      }
    );
  } finally {
    await rm(dst, { recursive: true, force: true });
  }
});

test("packPluginDirectory rejects plugins exceeding max bundle size", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-limit-"));
  try {
    await writeFile(path.join(src, "huge.bin"), Buffer.alloc(2000));
    await assert.rejects(
      async () => {
        await packPluginDirectory(src, { maxSizeBytes: 1000 });
      },
      {
        message: /Bundle size exceeds limit/,
      }
    );
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});

test("packPluginDirectory respects package.json files array when defined", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-pkg-files-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-pkg-dst-"));
  try {
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: "test-plugin",
        files: ["client/", "server/", "README.md", "!server/test.js"],
      }),
    );
    await writeFile(
      path.join(src, "paseo-plugin.json"),
      JSON.stringify({ id: "test-plugin" }),
    );
    await writeFile(path.join(src, "README.md"), "# Test Plugin");
    await mkdir(path.join(src, "client"), { recursive: true });
    await writeFile(path.join(src, "client/index.js"), "client code");
    await mkdir(path.join(src, "server"), { recursive: true });
    await writeFile(path.join(src, "server/index.js"), "server code");
    await writeFile(path.join(src, "server/test.js"), "test code (excluded)");
    await mkdir(path.join(src, "docs"), { recursive: true });
    await writeFile(path.join(src, "docs/large.png"), "huge doc screenshot");

    const packed = await packPluginDirectory(src);
    const res = await unpackBundle(packed.buffer, dst);
    assert.equal(res.fileCount, 5); // package.json, paseo-plugin.json, README.md, client/index.js, server/index.js
    assert.equal(await readFile(path.join(dst, "client/index.js"), "utf8"), "client code");
    assert.equal(await readFile(path.join(dst, "server/index.js"), "utf8"), "server code");
    await assert.rejects(async () => readFile(path.join(dst, "server/test.js")));
    await assert.rejects(async () => readFile(path.join(dst, "docs/large.png")));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("matchPattern and packPluginDirectory preserve globstar recursive wildcard semantics", async () => {
  const { matchPattern } = await import("../server/core/bundle.mjs");
  assert.equal(matchPattern("index.js", "**/*.js"), true);
  assert.equal(matchPattern("dist/index.js", "**/*.js"), true);
  assert.equal(matchPattern("dist/nested/index.js", "**/*.js"), true);
  assert.equal(matchPattern("dist/index.ts", "**/*.js"), false);
  assert.equal(matchPattern("dist/index.js", "dist/**/*.js"), true);
  assert.equal(matchPattern("dist/nested/deep/index.js", "dist/**/*.js"), true);
  assert.equal(matchPattern("other/index.js", "dist/**/*.js"), false);
});

test("packPluginDirectory excludes local secrets and honors ignore files", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-secrets-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-secrets-dst-"));
  try {
    await writeFile(
      path.join(src, "paseo-plugin.json"),
      JSON.stringify({ id: "secret-test" }),
    );
    await writeFile(path.join(src, "index.js"), "console.log('hi');");
    await writeFile(path.join(src, ".env"), "API_KEY=secret");
    await writeFile(path.join(src, ".env.local"), "SECRET=true");
    await writeFile(path.join(src, ".env.example"), "API_KEY=your_key_here");
    await writeFile(path.join(src, ".npmrc"), "//registry.npmjs.org/:_authToken=secret");
    await writeFile(path.join(src, "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----");
    await writeFile(path.join(src, ".gitignore"), "ignored.txt\nbuild/\n");
    await writeFile(path.join(src, "ignored.txt"), "should be ignored");
    await mkdir(path.join(src, "build"), { recursive: true });
    await writeFile(path.join(src, "build/out.js"), "ignored build output");

    const packed = await packPluginDirectory(src);
    const res = await unpackBundle(packed.buffer, dst);

    assert.equal(await readFile(path.join(dst, "index.js"), "utf8"), "console.log('hi');");
    assert.equal(await readFile(path.join(dst, ".env.example"), "utf8"), "API_KEY=your_key_here");
    await assert.rejects(async () => readFile(path.join(dst, ".env")));
    await assert.rejects(async () => readFile(path.join(dst, ".env.local")));
    await assert.rejects(async () => readFile(path.join(dst, ".npmrc")));
    await assert.rejects(async () => readFile(path.join(dst, "id_rsa")));
    await assert.rejects(async () => readFile(path.join(dst, "ignored.txt")));
    await assert.rejects(async () => readFile(path.join(dst, "build/out.js")));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("preserve executable permissions through bundle round trips", async () => {
  if (process.platform === "win32") return;
  const src = await mkdtemp(path.join(tmpdir(), "bundle-perm-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-perm-dst-"));
  try {
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "perm-test" }));
    const helperPath = path.join(src, "helper.sh");
    await writeFile(helperPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    const { chmod } = await import("node:fs/promises");
    await chmod(helperPath, 0o755);

    const normalPath = path.join(src, "normal.txt");
    await writeFile(normalPath, "regular file", { mode: 0o644 });
    await chmod(normalPath, 0o644);

    const packed = await packPluginDirectory(src);
    await unpackBundle(packed.buffer, dst);

    const { stat } = await import("node:fs/promises");
    const helperStat = await stat(path.join(dst, "helper.sh"));
    const normalStat = await stat(path.join(dst, "normal.txt"));

    assert.equal((helperStat.mode & 0o111) !== 0, true, "helper.sh should retain executable bit");
    assert.equal((normalStat.mode & 0o111) === 0, true, "normal.txt should not have executable bit");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("validate tar path components by UTF-8 byte length and reject unrepresentable long names", async () => {
  const { buildTarHeader } = await import("../server/core/bundle.mjs");

  // 1. Basename exceeding 100 UTF-8 bytes (e.g. 60 'é' chars = 120 bytes) cannot fit in ustar 100-byte name field
  const longMultibyteBasename = "assets/" + "é".repeat(60) + ".js";
  assert.throws(
    () => buildTarHeader(longMultibyteBasename, 10),
    /Path too long for tar header/,
  );

  // 2. Multibyte path that splits cleanly across prefix (<= 155 bytes) and shortName (<= 100 bytes)
  const prefixPart = "assets/" + "é".repeat(30); // 7 + 60 = 67 bytes <= 155
  const namePart = "é".repeat(30) + ".js"; // 60 + 3 = 63 bytes <= 100
  const validMultibytePath = `${prefixPart}/${namePart}`;
  const header = buildTarHeader(validMultibytePath, 5);
  const parsed = parseTarEntries(Buffer.concat([header, Buffer.alloc(512)]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, validMultibytePath);

  // 3. Regular ASCII long path (> 100 bytes) splitting cleanly
  const longAsciiPath = "deep/directory/structure/that/exceeds/one/hundred/bytes/in/total/length/to/test/prefix/handling/file.js";
  const asciiHeader = buildTarHeader(longAsciiPath, 5);
  const parsedAscii = parseTarEntries(Buffer.concat([asciiHeader, Buffer.alloc(512)]));
  assert.equal(parsedAscii.length, 1);
  assert.equal(parsedAscii[0].name, longAsciiPath);
});

test("allow filenames with consecutive dots while rejecting parent-directory traversal segments", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-dots-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-dots-dst-"));
  try {
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "dots-test" }));
    await writeFile(path.join(src, "loading...svg"), "<svg/>");
    await mkdir(path.join(src, "pages"), { recursive: true });
    await writeFile(path.join(src, "pages/[[...slug]].tsx"), "export default function Page() {}");
    await writeFile(path.join(src, "a..b.js"), "export const x = 1;");

    const packed = await packPluginDirectory(src);
    await unpackBundle(packed.buffer, dst);

    assert.equal(await readFile(path.join(dst, "loading...svg"), "utf8"), "<svg/>");
    assert.equal(
      await readFile(path.join(dst, "pages/[[...slug]].tsx"), "utf8"),
      "export default function Page() {}",
    );
    assert.equal(await readFile(path.join(dst, "a..b.js"), "utf8"), "export const x = 1;");

    const { buildTarHeader } = await import("../server/core/bundle.mjs");
    const { gzipSync } = await import("node:zlib");
    const badHeader = buildTarHeader("pages/../escape.txt", 4);
    const badData = Buffer.alloc(512);
    Buffer.from("evil").copy(badData);
    const badArchive = gzipSync(Buffer.concat([badHeader, badData, Buffer.alloc(1024)]));
    await assert.rejects(
      async () => unpackBundle(badArchive, dst),
      /Path traversal detected in archive entry/,
    );
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("packPluginDirectory checks file size via stat before allocating buffer via readFile", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-stat-limit-"));
  const { truncate, chmod } = await import("node:fs/promises");
  try {
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "stat-limit" }));
    const hugeFile = path.join(src, "huge.bin");
    await writeFile(hugeFile, "");
    await truncate(hugeFile, 30 * 1024 * 1024); // 30 MiB > 25 MiB limit
    if (process.platform !== "win32") {
      // Remove read permission so readFile would throw EACCES if called before stat check
      await chmod(hugeFile, 0o000);
    }

    await assert.rejects(
      async () => packPluginDirectory(src),
      /Bundle size exceeds limit/,
    );
  } finally {
    if (process.platform !== "win32") {
      try {
        await chmod(path.join(src, "huge.bin"), 0o644);
      } catch {}
    }
    await rm(src, { recursive: true, force: true });
  }
});

test("packPluginDirectory honors nested directory-scoped .npmignore and .gitignore rules across non-Git, Git, and files-allowlist plugins", async () => {
  const { execFileSync } = await import("node:child_process");

  // 1. Non-Git plugin with nested private/.npmignore
  const src1 = await mkdtemp(path.join(tmpdir(), "bundle-nested-npm-"));
  try {
    await writeFile(path.join(src1, "paseo-plugin.json"), JSON.stringify({ id: "nested-npm" }));
    await writeFile(path.join(src1, "index.js"), "export default 1;");
    await mkdir(path.join(src1, "private"), { recursive: true });
    await writeFile(path.join(src1, "private/.npmignore"), "credentials.json\n");
    await writeFile(path.join(src1, "private/credentials.json"), JSON.stringify({ token: "secret" }));
    await writeFile(path.join(src1, "private/helper.js"), "export const ok = true;");

    const packed1 = await packPluginDirectory(src1);
    assert.equal("private/credentials.json" in packed1.files, false);
    assert.equal("private/.npmignore" in packed1.files, false);
    assert.equal("private/helper.js" in packed1.files, true);
    assert.equal("index.js" in packed1.files, true);
  } finally {
    await rm(src1, { recursive: true, force: true });
  }

  // 2. Git worktree where private/credentials.json is tracked in Git, but excluded by private/.npmignore
  const src2 = await mkdtemp(path.join(tmpdir(), "bundle-nested-git-npm-"));
  try {
    await writeFile(path.join(src2, "paseo-plugin.json"), JSON.stringify({ id: "nested-git-npm" }));
    await writeFile(path.join(src2, "index.js"), "export default 2;");
    await mkdir(path.join(src2, "private"), { recursive: true });
    await writeFile(path.join(src2, "private/.npmignore"), "credentials.json\n");
    await writeFile(path.join(src2, "private/credentials.json"), JSON.stringify({ token: "tracked-secret" }));
    await writeFile(path.join(src2, "private/helper.js"), "export const ok = 2;");

    const git = (...args) =>
      execFileSync("git", ["-c", "core.fsmonitor=false", "-C", src2, ...args], {
        encoding: "utf8",
      });
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "-qm", "init");

    const packed2 = await packPluginDirectory(src2);
    assert.equal("private/credentials.json" in packed2.files, false);
    assert.equal("private/helper.js" in packed2.files, true);
    assert.equal("index.js" in packed2.files, true);
  } finally {
    await rm(src2, { recursive: true, force: true });
  }

  // 3. Non-Git plugin with nested sub/.gitignore and package.json files directory allowlist with nested .npmignore
  const src3 = await mkdtemp(path.join(tmpdir(), "bundle-nested-allowlist-"));
  try {
    await writeFile(
      path.join(src3, "package.json"),
      JSON.stringify({ name: "nested-allowlist", files: ["lib/"] }),
    );
    await writeFile(path.join(src3, "paseo-plugin.json"), JSON.stringify({ id: "nested-allowlist" }));
    await mkdir(path.join(src3, "lib/private"), { recursive: true });
    await writeFile(path.join(src3, "lib/index.js"), "export const lib = 1;");
    await writeFile(path.join(src3, "lib/private/.npmignore"), "credentials.json\n");
    await writeFile(path.join(src3, "lib/private/credentials.json"), "secret");

    const packed3 = await packPluginDirectory(src3);
    assert.equal("lib/index.js" in packed3.files, true);
    assert.equal("lib/private/credentials.json" in packed3.files, false);
  } finally {
    await rm(src3, { recursive: true, force: true });
  }
});

test("matchPattern and package.json files allowlist preserve brace expansion, character classes, and extglobs", async () => {
  const { matchPattern } = await import("../server/core/bundle.mjs");

  assert.equal(matchPattern("index.js", "*.{js,ts}"), true);
  assert.equal(matchPattern("index.ts", "*.{js,ts}"), true);
  assert.equal(matchPattern("index.css", "*.{js,ts}"), false);
  assert.equal(matchPattern("src/a/b.mjs", "src/**/*.{js,{cjs,mjs}}"), true);
  assert.equal(matchPattern("index.js", "*.[jt]s"), true);
  assert.equal(matchPattern("index.ts", "*.[jt]s"), true);
  assert.equal(matchPattern("index.d.ts", "index.[!d].ts"), false);
  assert.equal(matchPattern("index.x.ts", "index.[!d].ts"), true);
  assert.equal(matchPattern("chunk1.js", "chunk[[:digit:]].js"), true);
  assert.equal(matchPattern("chunkA.js", "chunk[[:digit:]].js"), false);
  assert.equal(matchPattern("entry.ts", "*.+(js|ts)"), true);
  assert.equal(matchPattern("entry.js", "!(*.test).js"), true);
  assert.equal(matchPattern("entry.test.js", "!(*.test).js"), false);

  const src = await mkdtemp(path.join(tmpdir(), "bundle-braces-src-"));
  const dst = await mkdtemp(path.join(tmpdir(), "bundle-braces-dst-"));
  try {
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({
        name: "glob-plugin",
        files: ["*.{js,ts}", "lib/**/*.[jt]s", "!lib/**/*.test.{js,ts}"],
      }),
    );
    await writeFile(path.join(src, "paseo-plugin.json"), JSON.stringify({ id: "glob-plugin" }));
    await writeFile(path.join(src, "index.js"), "export const main = true;");
    await writeFile(path.join(src, "types.ts"), "export type T = string;");
    await writeFile(path.join(src, "notes.txt"), "excluded note");
    await mkdir(path.join(src, "lib"), { recursive: true });
    await writeFile(path.join(src, "lib/helper.js"), "export const h = 1;");
    await writeFile(path.join(src, "lib/util.ts"), "export const u = 2;");
    await writeFile(path.join(src, "lib/helper.test.js"), "excluded test");

    const packed = await packPluginDirectory(src);
    await unpackBundle(packed.buffer, dst);

    assert.equal(await readFile(path.join(dst, "index.js"), "utf8"), "export const main = true;");
    assert.equal(await readFile(path.join(dst, "types.ts"), "utf8"), "export type T = string;");
    assert.equal(await readFile(path.join(dst, "lib/helper.js"), "utf8"), "export const h = 1;");
    assert.equal(await readFile(path.join(dst, "lib/util.ts"), "utf8"), "export const u = 2;");
    await assert.rejects(async () => readFile(path.join(dst, "notes.txt")));
    await assert.rejects(async () => readFile(path.join(dst, "lib/helper.test.js")));
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("empty package.json files: [] allowlist bundles only root mandatory metadata files", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "bundle-empty-files-"));
  try {
    await writeFile(
      path.join(src, "package.json"),
      JSON.stringify({ name: "empty-files-plugin", files: [] }),
    );
    await writeFile(
      path.join(src, "paseo-plugin.json"),
      JSON.stringify({ id: "empty-files-plugin" }),
    );
    await writeFile(path.join(src, "README.md"), "# Readme");
    await writeFile(path.join(src, "index.js"), "export const x = 1;");
    await mkdir(path.join(src, "private"), { recursive: true });
    await writeFile(path.join(src, "private/data.json"), "{}");
    await writeFile(path.join(src, "private/README.md"), "sub readme");

    const packed = await packPluginDirectory(src);
    assert.deepEqual(Object.keys(packed.files).sort(), [
      "README.md",
      "package.json",
      "paseo-plugin.json",
    ]);
  } finally {
    await rm(src, { recursive: true, force: true });
  }
});

test("buildTarBuffer and packPluginDirectory sort entries by UTF-16 code units independent of locale", async () => {
  const { buildTarBuffer, parseTarEntries } = await import(
    "../server/core/bundle.mjs"
  );
  const tar = buildTarBuffer([
    { name: "z.js", content: Buffer.from("z") },
    { name: "ä.js", content: Buffer.from("ae") },
    { name: "a.js", content: Buffer.from("a") },
  ]);
  const parsed = parseTarEntries(tar);
  assert.deepEqual(
    parsed.map((e) => e.name),
    ["a.js", "z.js", "ä.js"],
  );
});
