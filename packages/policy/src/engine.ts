import path from "node:path";
import type {
  CapabilityEffectMeta,
  EffectClass,
  GrantScope,
  PolicyEvaluationRecord,
  ResourceTarget,
} from "@openharbor/schemas";

export interface PolicyContext {
  sessionId: string;
  /** Approved test adapter names for this session */
  approvedAdapters: Set<string>;
  /** Ephemeral grants usable once in the current invocation */
  approvalGrantsOnce: Set<string>;
  /** Task-scoped grants for current task */
  approvalGrantsTask: Set<string>;
  /** Session-scoped grants */
  approvalGrantsSession: Set<string>;
}

export interface ApprovalGrant {
  scope: GrantScope;
  effectClass: EffectClass;
  targetId?: string;
}

export function approvalGrantKey(effectClass: EffectClass, targetId: string): string {
  return `${effectClass}:${targetId}`;
}

function findMatchingGrant(
  effect: CapabilityEffectMeta,
  target: ResourceTarget,
  ctx: PolicyContext,
): { scope: GrantScope; key: string } | null {
  const exact = approvalGrantKey(effect.effectClass, target.id);
  const wildcard = approvalGrantKey(effect.effectClass, "*");
  const search = (
    keys: Set<string>,
    scope: GrantScope,
  ): { scope: GrantScope; key: string } | null => {
    if (keys.has(exact)) {
      return { scope, key: exact };
    }
    if (keys.has(wildcard)) {
      return { scope, key: wildcard };
    }
    return null;
  };
  return (
    search(ctx.approvalGrantsOnce, "once") ??
    search(ctx.approvalGrantsTask, "task") ??
    search(ctx.approvalGrantsSession, "session")
  );
}

export interface PolicyRule {
  readonly id: string;
  /** Return null to fall through to next rule */
  evaluate(
    effect: CapabilityEffectMeta,
    target: ResourceTarget,
    ctx: PolicyContext,
  ): PolicyEvaluationRecord | null;
}

export const policyPresetNames = ["permissive", "balanced", "strict"] as const;

export type PolicyPresetName = (typeof policyPresetNames)[number];

const defaultApprovalIntent = (effect: CapabilityEffectMeta, target: ResourceTarget): string => {
  if (effect.effectClass === "publish.repo") {
    const p = target.path ?? target.id;
    if (p && p !== "." && !p.includes("..")) {
      return `Publish draft changes to ${path.basename(p)}`;
    }
    return "Publish draft changes to repository";
  }
  if (effect.effectClass === "execute.adapter") {
    return `Run test adapter ${target.id}`;
  }
  return `${effect.effectClass} on ${target.id}`;
};

const defaultNextAction = (effect: CapabilityEffectMeta): string => {
  if (effect.effectClass === "publish.repo") {
    return "Review draft changes, then grant publish approval with the intended scope.";
  }
  if (effect.effectClass === "execute.adapter") {
    return "Approve this adapter run for once, task, or session scope.";
  }
  return "Request explicit approval for this effect before retrying.";
};

/**
 * Ordered rules; first non-null evaluation wins.
 */
export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[]) {}

  evaluate(
    effect: CapabilityEffectMeta,
    target: ResourceTarget,
    ctx: PolicyContext,
  ): PolicyEvaluationRecord {
    for (const rule of this.rules) {
      const r = rule.evaluate(effect, target, ctx);
      if (r) {
        return r;
      }
    }
    return {
      decision: "deny",
      reason: "no matching policy rule",
    };
  }
}

export function resolvePolicyPreset(input?: string | null): PolicyPresetName {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return "balanced";
  }
  if ((policyPresetNames as readonly string[]).includes(normalized)) {
    return normalized as PolicyPresetName;
  }
  throw new Error(
    `Unknown Harbor policy preset "${input}". Expected one of: ${policyPresetNames.join(", ")}`,
  );
}

/** Baseline policy for local development: read repo/draft by default, gate tests and publish via approval flow. */
export function createPolicyPresetRules(preset: PolicyPresetName): PolicyRule[] {
  return [
    {
      id: "deny-destructive",
      evaluate(effect) {
        if (effect.effectClass === "destructive.repo") {
          return { decision: "deny", reason: "destructive.repo is denied in v0" };
        }
        return null;
      },
    },
    {
      id: "approval-grants",
      evaluate(effect, target, ctx) {
        const grant = findMatchingGrant(effect, target, ctx);
        if (!grant) {
          return null;
        }
        return {
          decision: "allow_with_limits",
          reason: `approved via ${grant.scope} grant`,
          limits: {
            grantScope: grant.scope,
            grantKey: grant.key,
          },
          grantScopeHint: grant.scope,
          targetLabel: target.id,
        };
      },
    },
    {
      id: "repo-read",
      evaluate(effect, target) {
        if (effect.effectClass === "read.repo" && target.kind === "repo_path") {
          return { decision: "allow" };
        }
        return null;
      },
    },
    {
      id: "draft",
      evaluate(effect) {
        if (effect.effectClass === "read.draft" || effect.effectClass === "write.draft") {
          return { decision: "allow" };
        }
        return null;
      },
    },
    {
      id: "artifacts",
      evaluate(effect) {
        if (
          effect.effectClass === "read.artifact" ||
          effect.effectClass === "write.artifact"
        ) {
          return { decision: "allow" };
        }
        return null;
      },
    },
    {
      id: "tests",
      evaluate(effect, target, ctx) {
        if (effect.effectClass !== "execute.adapter") {
          return null;
        }
        if (target.kind !== "adapter") {
          return { decision: "deny", reason: "adapter target required" };
        }
        if (preset === "permissive") {
          return { decision: "allow" };
        }
        if (preset === "balanced" && ctx.approvedAdapters.has(target.id)) {
          return { decision: "allow" };
        }
        return {
          decision: "require_approval",
          reason:
            preset === "strict"
              ? "strict preset requires approval for all adapter execution"
              : "adapter not in approved set",
          approvalIntent: defaultApprovalIntent(effect, target),
          nextAction: defaultNextAction(effect),
          targetLabel: target.id,
          grantScopeHint: "once",
        };
      },
    },
    {
      id: "publish",
      evaluate(effect, target) {
        if (effect.effectClass !== "publish.repo") {
          return null;
        }
        return {
          decision: "require_approval",
          approvalIntent: defaultApprovalIntent(effect, target),
          nextAction: defaultNextAction(effect),
          targetLabel: target.path ?? target.id,
          grantScopeHint: "once",
        };
      },
    },
    {
      id: "fallback-deny",
      evaluate(effect: CapabilityEffectMeta, target: ResourceTarget) {
        return {
          decision: "deny",
          reason: `effect ${effect.effectClass} not permitted by default for target ${target.kind}:${target.id}`,
          nextAction: "Use a capability with an allowed effect class or adjust policy preset/rules.",
          targetLabel: `${target.kind}:${target.id}`,
        };
      },
    },
  ];
}

export function createPolicyEngine(preset: PolicyPresetName = "balanced"): PolicyEngine {
  return new PolicyEngine(createPolicyPresetRules(preset));
}

export function createDefaultPolicyRules(): PolicyRule[] {
  return createPolicyPresetRules("balanced");
}

export function createDefaultPolicyEngine(): PolicyEngine {
  return createPolicyEngine("balanced");
}

/** Map effect class to a minimal capability effect meta for policy tests */
export function effectClassMeta(effectClass: EffectClass): CapabilityEffectMeta {
  return { effectClass };
}
