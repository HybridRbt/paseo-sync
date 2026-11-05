import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveOpenCommand,
  openShortcut,
} from "../server/core/open-shortcut.mjs";

test("resolveOpenCommand resolves platform-appropriate commands for fileManager and terminal", () => {
  // macOS
  assert.deepEqual(resolveOpenCommand("darwin", "fileManager", "/my/checkout"), {
    command: "/usr/bin/open",
    args: ["/my/checkout"],
  });
  assert.deepEqual(resolveOpenCommand("darwin", "terminal", "/my/checkout"), {
    command: "/usr/bin/open",
    args: ["-a", "Terminal", "/my/checkout"],
  });

  // Windows
  assert.deepEqual(resolveOpenCommand("win32", "fileManager", "C:\\checkout"), {
    command: "explorer.exe",
    args: ["C:\\checkout"],
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(resolveOpenCommand("win32", "terminal", "C:\\checkout"), {
    command: "cmd.exe",
    args: ["/c", "start", "cmd.exe", "/K", 'cd /d "C:\\checkout"'],
  });

  // Linux default
  assert.deepEqual(
    resolveOpenCommand("linux", "fileManager", "/home/user/checkout", {}),
    {
      command: "xdg-open",
      args: ["/home/user/checkout"],
    },
  );
  assert.deepEqual(
    resolveOpenCommand("linux", "terminal", "/home/user/checkout", {}),
    {
      command: "x-terminal-emulator",
      args: ["--working-directory=/home/user/checkout"],
    },
  );
  // Linux with custom TERMINAL env
  assert.deepEqual(
    resolveOpenCommand("linux", "terminal", "/home/user/checkout", {
      TERMINAL: "kitty",
    }),
    {
      command: "kitty",
      args: ["--working-directory=/home/user/checkout"],
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

test("openShortcut executes command via execFile and handles success and errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "open-test-"));
  try {
    const executed = [];
    const mockExecSuccess = (cmd, args, opts, cb) => {
      executed.push({ cmd, args, opts });
      cb(null);
    };

    const res = await openShortcut(dir, "terminal", {
      platform: "darwin",
      exec: mockExecSuccess,
    });
    assert.deepEqual(res, { status: "opened" });
    assert.equal(executed.length, 1);
    assert.equal(executed[0].cmd, "/usr/bin/open");
    assert.deepEqual(executed[0].args, ["-a", "Terminal", dir]);

    const mockExecFail = (cmd, args, opts, cb) => {
      cb(new Error("Command failed with code 1"));
    };
    const failRes = await openShortcut(dir, "fileManager", {
      platform: "linux",
      exec: mockExecFail,
    });
    assert.equal(failRes.status, "failed");
    assert.ok(failRes.error.includes("Command failed with code 1"));
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
  ];

  for (const [key, expectedEn, expectedZh, params] of keys) {
    assert.equal(en(key, params), expectedEn);
    assert.equal(zh(key, params), expectedZh);
  }
});
