import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

export function resolveOpenCommand(platform, target, dir, env = process.env) {
  if (target === "fileManager") {
    if (platform === "darwin") {
      return { command: "/usr/bin/open", args: [dir] };
    }
    if (platform === "win32") {
      return {
        command: "explorer.exe",
        args: [dir],
        windowsVerbatimArguments: true,
      };
    }
    return { command: "xdg-open", args: [dir] };
  }
  if (target === "terminal") {
    if (platform === "darwin") {
      return { command: "/usr/bin/open", args: ["-a", "Terminal", dir] };
    }
    if (platform === "win32") {
      return {
        command: "cmd.exe",
        args: ["/c", "start", "cmd.exe", "/K", `cd /d "${dir}"`],
      };
    }
    const terminal = env.TERMINAL || "x-terminal-emulator";
    return { command: terminal, args: ["--working-directory=" + dir] };
  }
  throw new Error(`Unsupported target: ${target}`);
}

export async function openShortcut(checkoutPath, target, options = {}) {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execFile;
  const env = options.env ?? process.env;
  const statFn = options.stat ?? stat;

  if (!checkoutPath || typeof checkoutPath !== "string") {
    return { status: "failed", error: "Missing or invalid checkout path" };
  }
  if (!path.isAbsolute(checkoutPath)) {
    return { status: "failed", error: "Checkout path must be absolute" };
  }
  const st = await statFn(checkoutPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { status: "failed", error: "Checkout directory not found" };
  }

  let cmdSpec;
  try {
    cmdSpec = resolveOpenCommand(platform, target, checkoutPath, env);
  } catch (e) {
    return { status: "unsupported", error: e.message };
  }

  return new Promise((resolve) => {
    exec(
      cmdSpec.command,
      cmdSpec.args,
      { windowsVerbatimArguments: cmdSpec.windowsVerbatimArguments },
      (error) => {
        if (error) {
          resolve({ status: "failed", error: error.message });
        } else {
          resolve({ status: "opened" });
        }
      },
    );
  });
}
