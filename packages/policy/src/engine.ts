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

/** Baseline policy for local development: read repo/draft by default, gate tests and publish via approval flow. */
export function createDefaultPolicyRules(): PolicyRule[] {
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
        if (ctx.approvedAdapters.has(target.id)) {
          return { decision: "allow" };
        }
        return {
          decision: "require_approval",
          reason: "adapter not in approved set",
          approvalIntent: defaultApprovalIntent(effect, target),
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
        };
      },
    },
    {
      id: "fallback-deny",
      evaluate(effect: CapabilityEffectMeta, target: ResourceTarget) {
        return {
          decision: "deny",
          reason: `effect ${effect.effectClass} not permitted by default for target ${target.kind}:${target.id}`,
        };
      },
    },
  ];
}

export function createDefaultPolicyEngine(): PolicyEngine {
  return new PolicyEngine(createDefaultPolicyRules());
}

/** Map effect class to a minimal capability effect meta for policy tests */
export function effectClassMeta(effectClass: EffectClass): CapabilityEffectMeta {
  return { effectClass };
}
