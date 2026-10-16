import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
const text = z
  .string()
  .max(4096)
  .refine((s) => !/[\x00-\x1f]/.test(s), "Control characters are not allowed");
export const syncSettings = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({
    checkout: text.default(""),
    repositoryUrl: text.default(""),
    cliPath: text.default(""),
    daemonHome: text.default(""),
  }),
});
