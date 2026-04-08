import type { ZodType } from "zod";
import type {
  AuditEvent,
  CapabilityEffectMeta,
  PolicyEvaluationRecord,
  ResourceTarget,
  SessionRecord,
} from "@openharbor/schemas";
import {
  ApprovalRequiredError,
  CapabilityNotFoundError,
  PolicyDeniedError,
  ValidationError,
} from "@openharbor/core";
import type { PolicyContext, PolicyEngine } from "@openharbor/policy";
import type { OverlayWorkspace } from "@openharbor/overlay";
import type { LocalHarborStore } from "./local-store.js";
import type { SessionManager } from "./session-manager.js";
import { makeAuditEvent } from "./audit.js";

export interface InvokeContext {
  session: SessionRecord;
  overlay: OverlayWorkspace;
  store: LocalHarborStore;
  sessions: SessionManager;
  policyContext: PolicyContext;
  persistWorkspace: () => Promise<void>;
  consumeApprovalGrantOnce?: (grantKey: string) => Promise<void>;
}

type CapabilityHandler<TIn, TOut> = (input: TIn, ctx: InvokeContext) => Promise<TOut>;

interface RegisteredCapability {
  name: string;
  description?: string;
  effect: CapabilityEffectMeta;
  input: ZodType<unknown>;
  output: ZodType<unknown>;
  resolveTarget: (input: unknown, session: SessionRecord) => ResourceTarget;
  handler: CapabilityHandler<unknown, unknown>;
}

export class CapabilityHost {
  private readonly registry = new Map<string, RegisteredCapability>();

  constructor(
    private readonly policy: PolicyEngine,
    private readonly store: LocalHarborStore,
  ) {}

  register<TIn, TOut>(def: {
    name: string;
    description?: string;
    effect: CapabilityEffectMeta;
    input: ZodType<TIn>;
    output: ZodType<TOut>;
    resolveTarget: (input: TIn, session: SessionRecord) => ResourceTarget;
    handler: CapabilityHandler<TIn, TOut>;
  }): void {
    const entry: RegisteredCapability = {
      name: def.name,
      description: def.description,
      effect: def.effect,
      input: def.input,
      output: def.output,
      resolveTarget: def.resolveTarget as (
        input: unknown,
        session: SessionRecord,
      ) => ResourceTarget,
      handler: def.handler as CapabilityHandler<unknown, unknown>,
    };
    this.registry.set(def.name, entry);
  }

  async invoke<TOut>(
    name: string,
    rawInput: unknown,
    ctx: InvokeContext,
  ): Promise<TOut> {
    const cap = this.registry.get(name);
    if (!cap) {
      throw new CapabilityNotFoundError(name);
    }

    let parsedInput: unknown;
    try {
      parsedInput = cap.input.parse(rawInput);
    } catch (e) {
      throw new ValidationError(`Invalid input for ${name}`, e);
    }

    const target = cap.resolveTarget(parsedInput, ctx.session);
    const record = this.policy.evaluate(cap.effect, target, ctx.policyContext);
    const onceGrantKey = getOnceGrantKey(record);
    if (onceGrantKey && ctx.consumeApprovalGrantOnce) {
      await ctx.consumeApprovalGrantOnce(onceGrantKey);
    }

    await this.writePolicyAudit(ctx.session.id, name, cap.effect, record);

    this.assertPolicyAllows(record, name);

    await this.appendAudit(ctx.session.id, {
      type: "capability.call",
      payload: {
        capabilityName: name,
        effectClass: cap.effect.effectClass,
        inputSummary: truncateForAudit(JSON.stringify(parsedInput)),
      },
    });

    let output: unknown;
    try {
      output = await cap.handler(parsedInput, ctx);
    } catch (err) {
      await this.appendAudit(ctx.session.id, {
        type: "capability.result",
        payload: {
          capabilityName: name,
          ok: false,
          error: String(err),
        },
      });
      throw err;
    }

    try {
      output = cap.output.parse(output);
    } catch (e) {
      throw new ValidationError(`Invalid output from ${name}`, e);
    }

    await this.appendAudit(ctx.session.id, {
      type: "capability.result",
      payload: buildCapabilityResultAuditPayload(name, output),
    });

    return output as TOut;
  }

  private assertPolicyAllows(record: PolicyEvaluationRecord, name: string): void {
    switch (record.decision) {
      case "allow":
        return;
      case "allow_with_limits":
        return;
      case "deny":
        throw new PolicyDeniedError(
          record.reason ?? `Policy denied capability ${name}`,
          record,
        );
      case "require_approval":
        throw new ApprovalRequiredError(
          record.approvalIntent ?? `Approval required for ${name}`,
          record,
        );
      default: {
        const _exhaustive: never = record.decision;
        throw new Error(`Unhandled policy decision: ${_exhaustive}`);
      }
    }
  }

  private async writePolicyAudit(
    sessionId: string,
    name: string,
    effect: CapabilityEffectMeta,
    record: PolicyEvaluationRecord,
  ): Promise<void> {
    await this.appendAudit(sessionId, {
      type: "policy.evaluation",
      payload: {
        capabilityName: name,
        effectClass: effect.effectClass,
        decision: record.decision,
        reason: record.reason,
        approvalIntent: record.approvalIntent,
        nextAction: record.nextAction,
        grantScopeHint: record.grantScopeHint,
        targetLabel: record.targetLabel,
      },
    });
  }

  private async appendAudit(
    sessionId: string,
    partial: Pick<AuditEvent, "type" | "payload">,
  ): Promise<void> {
    const event = makeAuditEvent(sessionId, partial.type, partial.payload);
    await this.store.appendAudit(sessionId, event);
  }

  listRegistered(): string[] {
    return [...this.registry.keys()].sort();
  }
}

function getOnceGrantKey(record: PolicyEvaluationRecord): string | null {
  if (record.decision !== "allow_with_limits" || !record.limits) {
    return null;
  }
  const limits = record.limits as Record<string, unknown>;
  if (limits.grantScope !== "once") {
    return null;
  }
  if (typeof limits.grantKey !== "string") {
    return null;
  }
  return limits.grantKey;
}

function truncateForAudit(s: string, max = 2_000): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}…`;
}

function buildCapabilityResultAuditPayload(
  capabilityName: string,
  output: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    capabilityName,
    ok: true,
  };
  if (!isRecord(output)) {
    return payload;
  }

  const artifactRefs = collectArtifactRefs(output);
  if (artifactRefs.length > 0) {
    payload.artifactRefs = artifactRefs;
  }
  if (typeof output.runId === "string") {
    payload.runId = output.runId;
  }

  const outputSummary: Record<string, unknown> = {};
  if (typeof output.found === "boolean") {
    outputSummary.found = output.found;
  }
  if (typeof output.changeCount === "number") {
    outputSummary.changeCount = output.changeCount;
  }
  if (typeof output.published === "boolean") {
    outputSummary.published = output.published;
  }
  if (typeof output.ok === "boolean") {
    outputSummary.ok = output.ok;
  }
  if (typeof output.exitCode === "number") {
    outputSummary.exitCode = output.exitCode;
  }
  if (typeof output.timedOut === "boolean") {
    outputSummary.timedOut = output.timedOut;
  }
  if (Object.keys(outputSummary).length > 0) {
    payload.outputSummary = outputSummary;
  }

  return payload;
}

function collectArtifactRefs(output: Record<string, unknown>): string[] {
  const refs = new Set<string>();

  if (typeof output.artifactId === "string") {
    refs.add(output.artifactId);
  }
  if (typeof output.stdoutArtifactId === "string") {
    refs.add(output.stdoutArtifactId);
  }
  if (typeof output.stderrArtifactId === "string") {
    refs.add(output.stderrArtifactId);
  }
  if (Array.isArray(output.artifacts)) {
    for (const artifact of output.artifacts) {
      if (!artifact || typeof artifact !== "object") {
        continue;
      }
      const candidate = (artifact as Record<string, unknown>).artifactId;
      if (typeof candidate === "string") {
        refs.add(candidate);
      }
    }
  }

  return [...refs];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
