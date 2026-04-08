import { z } from "zod";

export const effectClassSchema = z.enum([
  "read.repo",
  "read.draft",
  "write.draft",
  "execute.adapter",
  "read.artifact",
  "write.artifact",
  "read.external",
  "write.external",
  "send.external",
  "publish.repo",
  "destructive.repo",
]);

export type EffectClass = z.infer<typeof effectClassSchema>;

export const resourceTargetSchema = z.object({
  kind: z.enum(["repo_path", "overlay_path", "artifact", "adapter", "session"]),
  id: z.string(),
  path: z.string().optional(),
});

export type ResourceTarget = z.infer<typeof resourceTargetSchema>;

export const capabilityEffectMetaSchema = z.object({
  effectClass: effectClassSchema,
  requiresApprovalByDefault: z.boolean().optional(),
  description: z.string().optional(),
});

export type CapabilityEffectMeta = z.infer<typeof capabilityEffectMetaSchema>;
