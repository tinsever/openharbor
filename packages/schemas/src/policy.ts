import { z } from "zod";

export const policyDecisionSchema = z.enum([
  "allow",
  "deny",
  "allow_with_limits",
  "require_approval",
]);

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const grantScopeSchema = z.enum(["once", "task", "session"]);

export type GrantScope = z.infer<typeof grantScopeSchema>;

export const policyEvaluationRecordSchema = z.object({
  decision: policyDecisionSchema,
  reason: z.string().optional(),
  limits: z.record(z.unknown()).optional(),
  approvalIntent: z.string().optional(),
  nextAction: z.string().optional(),
  grantScopeHint: grantScopeSchema.optional(),
  targetLabel: z.string().optional(),
});

export type PolicyEvaluationRecord = z.infer<typeof policyEvaluationRecordSchema>;
