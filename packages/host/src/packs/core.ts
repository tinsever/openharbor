import type { CapabilityPackDefinition } from "../capability-packs.js";
import { registerBuiltinCapabilities } from "../builtins.js";

export const coreCapabilityPack: CapabilityPackDefinition = {
  manifest: {
    id: "core",
    version: "1.0.0",
    title: "Core capabilities",
    description: "Repository, workspace, tests, approvals, artifacts, and publish capabilities.",
    policyHooks: ["approval_grants", "policy_presets", "audit_events"],
    artifactContract: {
      kind: "consumes_and_produces",
      description: "Core capabilities store, read, and link session artifacts.",
    },
  },
  register: (host) => registerBuiltinCapabilities(host),
};
