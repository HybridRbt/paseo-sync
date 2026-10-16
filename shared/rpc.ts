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

const repositoryCandidate = z.object({
  checkout: z.string(),
  repositoryUrl: z.string().nullable(),
  pushUrl: z.string().nullable(),
  remoteWarning: z.boolean(),
  source: z.enum(["saved", "history", "search"]),
});
export const discoverRpc = defineRpc({
  name: "sync.discover",
  input: z.object({
    checkout: z
      .string()
      .max(4096)
      .refine((s) => !/[\x00-\x1f]/.test(s))
      .optional(),
  }),
  output: z.object({
    candidates: z.array(repositoryCandidate),
    selected: repositoryCandidate.nullable(),
    savedInvalid: z.boolean(),
    limited: z.boolean(),
    scanned: z.number(),
  }),
});
