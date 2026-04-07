import { z } from "zod";
import { policyDecisionSchema } from "./policy.js";
import { effectClassSchema } from "./effects.js";

export const auditEventTypeSchema = z.enum([
  "session.created",
  "session.closed",
  "model_run.started",
  "model_run.completed",
  "model_run.failed",
  "capability.call",
  "capability.result",
  "policy.evaluation",
  "approval.granted",
  "overlay.mutated",
  "review.revised",
  "review.discarded",
  "publish.requested",
  "publish.approved",
  "publish.applied",
  "publish.rejected",
]);

export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  ts: z.string(),
  sessionId: z.string().uuid(),
  type: auditEventTypeSchema,
  payload: z.record(z.unknown()),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const capabilityCallAuditPayloadSchema = z.object({
  capabilityName: z.string(),
  inputSummary: z.string(),
  effectClass: effectClassSchema,
  targetId: z.string(),
});

export const policyAuditPayloadSchema = z.object({
  capabilityName: z.string(),
  effectClass: effectClassSchema,
  decision: policyDecisionSchema,
  reason: z.string().optional(),
});
