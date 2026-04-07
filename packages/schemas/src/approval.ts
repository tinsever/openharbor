import { z } from "zod";
import { effectClassSchema } from "./effects.js";
import { grantScopeSchema } from "./policy.js";

export const approvalGrantStatusSchema = z.enum(["active", "consumed", "revoked"]);

export type ApprovalGrantStatus = z.infer<typeof approvalGrantStatusSchema>;

export const approvalGrantRecordSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  scope: grantScopeSchema,
  effectClass: effectClassSchema,
  targetId: z.string(),
  taskId: z.string().optional(),
  status: approvalGrantStatusSchema,
  issuedAt: z.string(),
  consumedAt: z.string().optional(),
  revokedAt: z.string().optional(),
  reason: z.string().optional(),
});

export type ApprovalGrantRecord = z.infer<typeof approvalGrantRecordSchema>;
