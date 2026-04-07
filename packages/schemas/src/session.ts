import { z } from "zod";

export const sessionStateSchema = z.enum(["active", "closed"]);

export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionRecordSchema = z.object({
  id: z.string().uuid(),
  repoPath: z.string(),
  name: z.string().optional(),
  state: sessionStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const sessionSnapshotSchema = sessionRecordSchema.extend({
  version: z.literal(1),
});

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
