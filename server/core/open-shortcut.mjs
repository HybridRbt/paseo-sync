import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export function resolveOpenCommand(platform, target, dir, env = process.env) {
  if (target === "fileManager") {
    if (platform === "darwin") {
      return { command: "/usr/bin/open", args: [dir], cwd: dir };
    }
    if (platform === "win32") {
      return {
        command: "explorer.exe",
        args: [dir],
        cwd: dir,
      };
    }
    return { command: "xdg-open", args: [dir], cwd: dir };
  }
  if (target === "terminal") {
    if (platform === "darwin") {
      return { command: "/usr/bin/open", args: ["-a", "Terminal", dir], cwd: dir };
    }
    if (platform === "win32") {
      return {
        command: "cmd.exe",
        args: ["/c", "start", "cmd.exe"],
        cwd: dir,
      };
    }
    const terminal = env.TERMINAL || "x-terminal-emulator";
    return { command: terminal, args: [], cwd: dir };
  }
  throw new Error(`Unsupported target: ${target}`);
}

export async function openShortcut(checkoutPath, target, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawn ?? spawn;
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

  if (options.exec) {
    return new Promise((resolve) => {
      options.exec(
        cmdSpec.command,
        cmdSpec.args,
        {
          cwd: cmdSpec.cwd,
          windowsVerbatimArguments: cmdSpec.windowsVerbatimArguments,
        },
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

  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawnFn(cmdSpec.command, cmdSpec.args, {
        cwd: cmdSpec.cwd,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: cmdSpec.windowsVerbatimArguments,
      });
    } catch (err) {
      return resolve({ status: "failed", error: err.message });
    }

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolve({ status: "failed", error: err.message });
      }
    });

    child.on("spawn", () => {
      if (typeof child.unref === "function") {
        child.unref();
      }
      if (!settled) {
        settled = true;
        resolve({ status: "opened" });
      }
    });
  });
}
