import { z } from "zod";
import { capabilityDescriptorSchema } from "./capability.js";

export const capabilityPolicyHookSchema = z.enum([
  "approval_grants",
  "policy_presets",
  "audit_events",
]);

export type CapabilityPolicyHook = z.infer<typeof capabilityPolicyHookSchema>;

export const artifactContractSchema = z.object({
  kind: z.enum(["none", "consumes", "produces", "consumes_and_produces"]),
  description: z.string().min(1),
});

export type ArtifactContract = z.infer<typeof artifactContractSchema>;

export const capabilityPackManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  policyHooks: z.array(capabilityPolicyHookSchema).default([]),
  artifactContract: artifactContractSchema.default({
    kind: "none",
    description: "No artifact contract declared.",
  }),
  capabilities: z.array(capabilityDescriptorSchema).min(1),
});

export type CapabilityPackManifest = z.infer<typeof capabilityPackManifestSchema>;
