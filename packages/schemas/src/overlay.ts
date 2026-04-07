import { z } from "zod";

export const overlayFileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["modify", "create", "delete"]),
  /** Present for modify/create */
  content: z.string().optional(),
});

export type OverlayFileChange = z.infer<typeof overlayFileChangeSchema>;

export const overlayPersistedStateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  baseRepoPath: z.string(),
  changes: z.array(overlayFileChangeSchema),
});

export type OverlayPersistedState = z.infer<typeof overlayPersistedStateSchema>;
