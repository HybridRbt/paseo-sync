import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { devNull } from "node:os";
const exec = promisify(execFile);
export async function git(root, ...args) {
  try {
    return (
      await exec(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=" + devNull,
          "-C",
          root,
          ...args,
        ],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            GIT_SSH_COMMAND:
              process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
          },
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
      )
    ).stdout.trim();
  } catch (e) {
    throw new Error(
      `Git ${args[0]} failed (${e.code ?? "error"}). Check repository state and noninteractive host credentials.`,
    );
  }
}
