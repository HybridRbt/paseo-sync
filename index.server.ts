import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { syncSettings } from "./shared/settings";
import { startRpc, jobRpc, unlockRpc, discoverRpc } from "./shared/rpc";
import { createService } from "./server/service.mjs";
import { publicError } from "./server/jobs.mjs";
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(syncSettings);
  const service = createService({
    stateRoot: undefined,
    readSettings: async () => {
      const s = await settings.read();
      if (s.status !== "ready") throw new Error(s.error);
      return s.values;
    },
  });
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Error(publicError(e));
    }
  }
  server.handle(discoverRpc, (input) => guarded(() => service.discover(input)));
  server.handle(startRpc, (input) => guarded(() => service.start(input)));
  server.handle(jobRpc, (input) =>
    guarded(async () => z.json().parse(await service.getJob(input.id))),
  );
  server.handle(unlockRpc, () => guarded(() => service.unlock()));
  return () => {};
}
