import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const startRpc = defineRpc({
  name: "sync.start",
  input: z.object({
    kind: z.enum([
      "prepare",
      "inspect",
      "plan",
      "apply",
      "publishPlan",
      "publish",
      "cafePlan",
      "cafe",
      "backups",
      "restorePlan",
      "restore",
      "verify",
    ]),
    approval: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    backupId: z
      .string()
      .regex(/^(cafe:)?[a-f0-9-]{36}$/)
      .optional(),
  }),
  output: z.object({ id: z.string(), kind: z.string(), status: z.string() }),
});
export const jobRpc = defineRpc({
  name: "sync.job",
  input: z.object({ id: z.string().uuid().optional() }),
  output: z.json(),
});
export const unlockRpc = defineRpc({
  name: "sync.unlock",
  input: z.object({}),
  output: z.object({ unlocked: z.boolean() }),
});
