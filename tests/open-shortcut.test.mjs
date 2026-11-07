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

test("bilingual translations cover copy path labels and feedback", async () => {
  const { translator } = await import("../client/i18n.mjs");
  const en = translator("en");
  const zh = translator("zh");

  const keys = [
    ["复制路径", "Copy path", "复制路径"],
    [
      "复制 {plugin} 源码目录路径",
      "Copy my-plugin source checkout path",
      "复制 my-plugin 源码目录路径",
      { plugin: "my-plugin" },
    ],
    ["已复制路径", "Path copied", "已复制路径"],
    [
      "复制失败：{error}，路径已显示在上方，可手动选中复制。",
      "Copy failed: Clipboard unavailable. The path is shown above; select and copy it manually.",
      "复制失败：Clipboard unavailable，路径已显示在上方，可手动选中复制。",
      { error: "Clipboard unavailable" },
    ],
  ];

  for (const [key, expectedEn, expectedZh, params] of keys) {
    assert.equal(en(key, params), expectedEn);
    assert.equal(zh(key, params), expectedZh);
  }
});

test("copyTextToClipboard writes through the clipboard API and degrades gracefully", async () => {
  const { copyTextToClipboard } = await import("../client/clipboard.mjs");

  // Success path: an injected clipboard provider receives the path verbatim.
  const written = [];
  await copyTextToClipboard("/my/checkout", {
    writeText: async (text) => {
      written.push(text);
    },
  });
  assert.deepEqual(written, ["/my/checkout"]);

  // Default lookup resolves globalThis.navigator.clipboard when present.
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const defaultWritten = [];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (text) => {
          defaultWritten.push(text);
        },
      },
    },
    configurable: true,
  });
  try {
    await copyTextToClipboard("/default/checkout");
    assert.deepEqual(defaultWritten, ["/default/checkout"]);
  } finally {
    Object.defineProperty(globalThis, "navigator", originalDescriptor);
  }

  // Missing clipboard (restricted webview, headless client) surfaces a
  // readable error the UI can disclose next to the selectable path.
  await assert.rejects(copyTextToClipboard("/my/checkout"), {
    message: "Clipboard unavailable in this environment",
  });

  // Underlying writeText failures propagate for the UI to disclose.
  await assert.rejects(
    copyTextToClipboard("/my/checkout", {
      writeText: async () => {
        throw new Error("not allowed");
      },
    }),
    { message: "not allowed" },
  );
});

test("formatConflict and overwrite mode translations render bilingually", async () => {
  const { translator, formatConflict } = await import("../client/i18n.mjs");
  const en = translator("en");
  const zh = translator("zh");

  assert.equal(
    formatConflict(
      "Local changes conflict with profile: better-paseo. Export local changes or review --prefer-profile.",
      zh,
    ),
    "本机配置与云端存在冲突：better-paseo。可选择「用本机配置覆盖云端」或「忽略本机改动，用云端覆盖本机」。",
  );
  assert.equal(
    formatConflict(
      "Local changes conflict with profile: better-paseo. Export local changes or review --prefer-profile.",
      en,
    ),
    "Local changes conflict with the cloud profile: better-paseo. Choose “Overwrite cloud with this host” or “Ignore local changes and apply cloud profile”.",
  );
  assert.equal(
    formatConflict(
      "Exact registry version transition is not supported: paseo-cafe. Review registry provenance separately; no reinstall will be attempted.",
      zh,
    ),
    "注册表安装的插件不支持直接切换历史版本：paseo-cafe。可选择「用本机配置覆盖云端」，或选择「用云端覆盖本机」保留本机版本，或选择「卸载重装注册表插件对齐」直接重装云端固定版本。",
  );
  assert.equal(
    formatConflict(
      "Exact registry version transition is not supported: paseo-cafe. Review registry provenance separately; no reinstall will be attempted.",
      en,
    ),
    "Exact registry version transition is not supported: paseo-cafe. Choose “Overwrite cloud with this host”, “Apply cloud profile” to keep the host version, or “Reinstall registry plugins to align” to reinstall the pinned cloud version.",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied changes for extra; apply or reconcile before exporting.",
      zh,
    ),
    "云端配置仓库存在尚未应用到本机的插件变更：extra。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied changes for extra; apply or reconcile before exporting.",
      en,
    ),
    "The configuration repository has unapplied changes for extra. Sync to this host first, or choose “Force overwrite cloud with this host”.",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied settings changes: settings/better-paseo/presentation.json",
      zh,
    ),
    "云端配置仓库存在尚未应用到本机的设置变更：settings/better-paseo/presentation.json。可先同步到本机，或选择「强制用本机配置覆盖云端」。",
  );
  assert.equal(
    formatConflict(
      "Repository has unapplied settings changes: settings/better-paseo/presentation.json",
      en,
    ),
    "The configuration repository has unapplied settings changes: settings/better-paseo/presentation.json. Sync to this host first, or choose “Force overwrite cloud with this host”.",
  );

  const uiKeys = [
    [
      "跳过 {plugin}：本地开发或未受管插件，本次不发布它的变更。",
      "Skipped demo: local development or untracked plugin; its changes are not published this time.",
      "跳过 demo：本地开发或未受管插件，本次不发布它的变更。",
      { plugin: "demo" },
    ],
    [
      "跳过 {plugin}：注册表安装插件不支持直接切换固定版本（本机 {head}，云端 {revision}），本次保留本机版本。",
      "Skipped cafe: registry-installed plugins do not support in-place version pinning (host 1.1.1, cloud 1.0.1); keeping host version.",
      "跳过 cafe：注册表安装插件不支持直接切换固定版本（本机 1.1.1，云端 1.0.1），本次保留本机版本。",
      { plugin: "cafe", head: "1.1.1", revision: "1.0.1" },
    ],
    [
      "用本机配置覆盖云端（预览发布）",
      "Overwrite cloud with this host (preview publish)",
      "用本机配置覆盖云端（预览发布）",
    ],
    [
      "忽略本机改动，用云端覆盖本机（重新预览）",
      "Ignore local changes, overwrite this host with cloud (re-preview)",
      "忽略本机改动，用云端覆盖本机（重新预览）",
    ],
    [
      "忽略云端未应用改动，强制用本机配置覆盖云端（重新预览）",
      "Ignore unapplied cloud changes, force overwrite cloud with this host (re-preview)",
      "忽略云端未应用改动，强制用本机配置覆盖云端（重新预览）",
    ],
    [
      "已启用「用云端覆盖本机」模式：将忽略本机自上次同步以来的本地修改，按云端配置应用。",
      "“Overwrite host with cloud” mode enabled: local edits since the last sync will be overwritten by the cloud profile.",
      "已启用「用云端覆盖本机」模式：将忽略本机自上次同步以来的本地修改，按云端配置应用。",
    ],
    [
      "已启用「用本机覆盖云端」模式：将忽略云端未应用的远端修改，直接导出本机当前配置。",
      "“Overwrite cloud with host” mode enabled: unapplied cloud changes will be overwritten by this host's current configuration.",
      "已启用「用本机覆盖云端」模式：将忽略云端未应用的远端修改，直接导出本机当前配置。",
    ],
    [
      "预览并应用或发布同步配置",
      "Preview and apply or publish the configuration",
      "预览并应用或发布同步配置",
    ],
  ];

  for (const [key, expectedEn, expectedZh, params] of uiKeys) {
    assert.equal(en(key, params), expectedEn);
    assert.equal(zh(key, params), expectedZh);
  }
});

