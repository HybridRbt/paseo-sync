import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  resolveOpenCommand,
  openShortcut,
} from "../server/core/open-shortcut.mjs";

test("resolveOpenCommand resolves platform-appropriate commands for fileManager and terminal", () => {
  // macOS
  assert.deepEqual(resolveOpenCommand("darwin", "fileManager", "/my/checkout"), {
    command: "/usr/bin/open",
    args: ["/my/checkout"],
    cwd: "/my/checkout",
  });
  assert.deepEqual(resolveOpenCommand("darwin", "terminal", "/my/checkout"), {
    command: "/usr/bin/open",
    args: ["-a", "Terminal", "/my/checkout"],
    cwd: "/my/checkout",
  });

  // Windows
  assert.deepEqual(resolveOpenCommand("win32", "fileManager", "C:\\checkout"), {
    command: "explorer.exe",
    args: ["C:\\checkout"],
    cwd: "C:\\checkout",
  });
  assert.deepEqual(resolveOpenCommand("win32", "terminal", "C:\\checkout"), {
    command: "cmd.exe",
    args: ["/c", "start", "cmd.exe"],
    cwd: "C:\\checkout",
  });

  // Linux default
  assert.deepEqual(
    resolveOpenCommand("linux", "fileManager", "/home/user/checkout", {}),
    {
      command: "xdg-open",
      args: ["/home/user/checkout"],
      cwd: "/home/user/checkout",
    },
  );
  assert.deepEqual(
    resolveOpenCommand("linux", "terminal", "/home/user/checkout", {}),
    {
      command: "x-terminal-emulator",
      args: [],
      cwd: "/home/user/checkout",
    },
  );
  // Linux with custom TERMINAL env (e.g. xterm, kitty)
  assert.deepEqual(
    resolveOpenCommand("linux", "terminal", "/home/user/checkout", {
      TERMINAL: "xterm",
    }),
    {
      command: "xterm",
      args: [],
      cwd: "/home/user/checkout",
    },
  );
  assert.deepEqual(
    resolveOpenCommand("linux", "terminal", "/home/user/checkout", {
      TERMINAL: "kitty",
    }),
    {
      command: "kitty",
      args: [],
      cwd: "/home/user/checkout",
    },
  );

  // Unsupported target
  assert.throws(() => resolveOpenCommand("darwin", "unknown", "/dir"), {
    message: /Unsupported target/,
  });
});

test("openShortcut rejects invalid, relative, or non-existent directories", async () => {
  assert.deepEqual(await openShortcut("", "terminal"), {
    status: "failed",
    error: "Missing or invalid checkout path",
  });
  assert.deepEqual(await openShortcut("relative/path", "terminal"), {
    status: "failed",
    error: "Checkout path must be absolute",
  });
  assert.deepEqual(await openShortcut("/non/existent/path/12345", "terminal"), {
    status: "failed",
    error: "Checkout directory not found",
  });
});

test("openShortcut executes command via spawn and resolves on launch without waiting for process exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "open-test-"));
  try {
    const spawned = [];
    let unrefCalled = false;
    const mockSpawnSuccess = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.unref = () => {
        unrefCalled = true;
      };
      // Emits spawn event without waiting for process exit
      process.nextTick(() => child.emit("spawn"));
      return child;
    };

    const res = await openShortcut(dir, "terminal", {
      platform: "linux",
      env: { TERMINAL: "kitty" },
      spawn: mockSpawnSuccess,
    });
    assert.deepEqual(res, { status: "opened" });
    assert.equal(unrefCalled, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, "kitty");
    assert.deepEqual(spawned[0].args, []);
    assert.equal(spawned[0].opts.cwd, dir);
    assert.equal(spawned[0].opts.detached, true);

    const mockSpawnFail = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() =>
        child.emit("error", new Error("spawn nonexistent-cmd ENOENT")),
      );
      return child;
    };
    const failRes = await openShortcut(dir, "terminal", {
      platform: "linux",
      env: { TERMINAL: "nonexistent-cmd" },
      spawn: mockSpawnFail,
    });
    assert.equal(failRes.status, "failed");
    assert.ok(failRes.error.includes("ENOENT"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openShortcut supports legacy exec option for backward compatibility", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "open-test-"));
  try {
    const executed = [];
    const mockExec = (cmd, args, opts, cb) => {
      executed.push({ cmd, args, opts });
      cb(null);
    };

    const res = await openShortcut(dir, "terminal", {
      platform: "darwin",
      exec: mockExec,
    });
    assert.deepEqual(res, { status: "opened" });
    assert.equal(executed.length, 1);
    assert.equal(executed[0].cmd, "/usr/bin/open");
    assert.deepEqual(executed[0].args, ["-a", "Terminal", dir]);
    assert.equal(executed[0].opts.cwd, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openCheckoutRpc validates input and output correctly", async () => {
  const { openCheckoutRpc } = await import("../shared/rpc.ts");
  assert.equal(openCheckoutRpc.name, "sync.open-checkout");

  // Valid inputs
  assert.ok(
    openCheckoutRpc.input.safeParse({
      path: "/absolute/checkout",
      target: "terminal",
    }).success,
  );
  assert.ok(
    openCheckoutRpc.input.safeParse({
      path: "C:\\checkout",
      target: "fileManager",
    }).success,
  );

  // Invalid target
  assert.equal(
    openCheckoutRpc.input.safeParse({
      path: "/absolute/checkout",
      target: "browser",
    }).success,
    false,
  );

  // Control characters
  assert.equal(
    openCheckoutRpc.input.safeParse({
      path: "/absolute/checkout\nrm -rf",
      target: "terminal",
    }).success,
    false,
  );

  // Valid outputs
  assert.ok(openCheckoutRpc.output.safeParse({ status: "opened" }).success);
  assert.ok(
    openCheckoutRpc.output.safeParse({
      status: "failed",
      error: "Directory not found",
    }).success,
  );
  assert.ok(openCheckoutRpc.output.safeParse({ status: "unsupported" }).success);
});

test("bilingual translations cover all checkout shortcut labels and feedback", async () => {
  const { translator } = await import("../client/i18n.mjs");
  const en = translator("en");
  const zh = translator("zh");

  const keys = [
    ["在终端中打开", "Open in terminal", "在终端中打开"],
    ["在文件管理器中打开", "Open in file manager", "在文件管理器中打开"],
    [
      "在终端中打开 {plugin} 源码目录",
      "Open my-plugin source checkout in terminal",
      "在终端中打开 my-plugin 源码目录",
      { plugin: "my-plugin" },
    ],
    [
      "在文件管理器中打开 {plugin} 源码目录",
      "Open my-plugin source checkout in file manager",
      "在文件管理器中打开 my-plugin 源码目录",
      { plugin: "my-plugin" },
    ],
    ["已打开终端", "Terminal opened", "已打开终端"],
    ["已在文件管理器中打开", "Opened in file manager", "已在文件管理器中打开"],
    [
      "打开失败：{error}",
      "Failed to open: Permission denied",
      "打开失败：Permission denied",
      { error: "Permission denied" },
    ],
    [
      "当前平台不支持该快捷方式。",
      "Shortcut unsupported on this platform.",
      "当前平台不支持该快捷方式。",
    ],
    ["未知错误", "Unknown error", "未知错误"],
    [
      "跳过 {plugin}：本地开发或未受管插件，本次不发布它的变更。",
      "Skipped my-plugin: local development or untracked plugin; its changes are not published this time.",
      "跳过 my-plugin：本地开发或未受管插件，本次不发布它的变更。",
      { plugin: "my-plugin" },
    ],
    ["离线归档", "Offline bundle", "离线归档"],
    ["新增离线归档包", "Add offline bundle archive", "新增离线归档包"],
    ["更新离线归档包", "Update offline bundle archive", "更新离线归档包"],
  ];

  for (const [key, expectedEn, expectedZh, params] of keys) {
    assert.equal(en(key, params), expectedEn);
    assert.equal(zh(key, params), expectedZh);
  }
});
