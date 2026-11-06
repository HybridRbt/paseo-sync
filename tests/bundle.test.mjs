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
