import {
  resolvePolicyPreset,
  type ApprovalGrant,
  type PolicyPresetName,
} from "@openharbor/policy";
import {
  ApprovalRequiredError,
  CapabilityNotFoundError,
  PolicyDeniedError,
  ValidationError,
} from "@openharbor/core";
import {
  createHarborEnvironment,
  type HarborEnvironment,
  type InvokePolicyOverrides,
  type RunModelTaskOptions,
  type RunModelTaskResult,
} from "@openharbor/host";

export interface PiIntegrationOptions {
  dataDir?: string;
  approvedAdapters?: Iterable<string>;
  policyPreset?: PolicyPresetName | string;
}

export { resolvePolicyPreset } from "@openharbor/policy";
export type { ApprovalGrant, PolicyPresetName } from "@openharbor/policy";

export interface InvokeRequest {
  sessionId: string;
  capability: string;
  input: unknown;
  taskId?: string;
  approvalGrants?: ApprovalGrant[];
}

export type PiInvokeResult =
  | {
      status: "ok";
      value: unknown;
    }
    | {
      status: "approval_required";
      message: string;
      intent?: string;
      reason?: string;
      nextAction?: string;
      grantScopeHint?: ApprovalGrant["scope"];
      targetLabel?: string;
      category?: string;
      errorCode?: string;
    }
  | {
      status: "denied";
      message: string;
      reason?: string;
      nextAction?: string;
      targetLabel?: string;
      category?: string;
      errorCode?: string;
    }
  | {
      status: "validation_error";
      message: string;
      issues: unknown;
      nextAction?: string;
      category?: string;
      errorCode?: string;
    };

export type PiRunModelTaskResult =
  | {
      status: "ok";
      value: RunModelTaskResult;
    }
    | {
      status: "approval_required";
      message: string;
      intent?: string;
      reason?: string;
      nextAction?: string;
      grantScopeHint?: ApprovalGrant["scope"];
      targetLabel?: string;
      category?: string;
      errorCode?: string;
    }
  | {
      status: "denied";
      message: string;
      reason?: string;
      nextAction?: string;
      targetLabel?: string;
      category?: string;
      errorCode?: string;
    }
  | {
      status: "validation_error";
      message: string;
      issues: unknown;
      nextAction?: string;
      category?: string;
      errorCode?: string;
    };

export interface HarborSessionSummary {
  id: string;
  repoPath: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Bridge layer for Pi-hosted UX surfaces (CLI/TUI) to interact with Harbor host semantics.
 * Harbor capability, policy, and approval behavior remains in core packages.
 */
export class PiHarborBridge {
  readonly env: HarborEnvironment;
  private readonly approvedAdapters: Set<string>;

  constructor(opts: PiIntegrationOptions = {}) {
    this.env = createHarborEnvironment({
      dataDir: opts.dataDir,
      policyPreset: resolvePolicyPreset(opts.policyPreset),
    });
    this.approvedAdapters = new Set(opts.approvedAdapters ?? []);
  }

  listCapabilities(): string[] {
    return this.env.capabilities.listRegistered();
  }

  async createSession(repoPath: string, name?: string): Promise<HarborSessionSummary> {
    const session = await this.env.sessions.createSession(repoPath, name);
    return {
      id: session.id,
      repoPath: session.repoPath,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async invoke(req: InvokeRequest): Promise<PiInvokeResult> {
    const overrides: InvokePolicyOverrides = {
      approvedAdapters: this.approvedAdapters,
      approvalGrants: req.approvalGrants,
      taskId: req.taskId,
    };

    try {
      const value = await this.env.invoke(req.sessionId, req.capability, req.input, overrides);
      return { status: "ok", value };
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        return {
          status: "approval_required",
          message: error.message,
          intent: error.record.approvalIntent,
          reason: error.record.reason,
          nextAction: error.record.nextAction,
          grantScopeHint: error.record.grantScopeHint,
          targetLabel: error.record.targetLabel,
          category: "approval_required",
          errorCode: "approval.required",
        };
      }
      if (error instanceof PolicyDeniedError) {
        return {
          status: "denied",
          message: error.message,
          reason: error.record.reason,
          nextAction: error.record.nextAction,
          targetLabel: error.record.targetLabel,
          category: "policy_denied",
          errorCode: "policy.denied",
        };
      }
      if (error instanceof CapabilityNotFoundError) {
        return {
          status: "validation_error",
          message: error.message,
          issues: { capabilityName: error.capabilityName },
          nextAction: "Choose a capability from `harbor caps` and retry.",
          category: "capability_error",
          errorCode: "capability.not_found",
        };
      }
      if (error instanceof ValidationError) {
        return {
          status: "validation_error",
          message: error.message,
          issues: error.issues,
          nextAction: "Fix invalid input and retry this capability call.",
          category: "validation_error",
          errorCode: "validation.failed",
        };
      }
      throw error;
    }
  }

  async runModelTask(
    sessionId: string,
    code: string,
    options?: Omit<RunModelTaskOptions, "policyOverrides"> & {
      approvalGrants?: ApprovalGrant[];
      taskId?: string;
    },
  ): Promise<PiRunModelTaskResult> {
    const policyOverrides: InvokePolicyOverrides = {
      approvedAdapters: this.approvedAdapters,
      approvalGrants: options?.approvalGrants,
      taskId: options?.taskId,
    };

    try {
      const value = await this.env.runModelTask(sessionId, code, {
        limits: options?.limits,
        taskId: options?.taskId,
        policyOverrides,
      });
      return { status: "ok", value };
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        return {
          status: "approval_required",
          message: error.message,
          intent: error.record.approvalIntent,
          reason: error.record.reason,
          nextAction: error.record.nextAction,
          grantScopeHint: error.record.grantScopeHint,
          targetLabel: error.record.targetLabel,
          category: "approval_required",
          errorCode: "approval.required",
        };
      }
      if (error instanceof PolicyDeniedError) {
        return {
          status: "denied",
          message: error.message,
          reason: error.record.reason,
          nextAction: error.record.nextAction,
          targetLabel: error.record.targetLabel,
          category: "policy_denied",
          errorCode: "policy.denied",
        };
      }
      if (error instanceof ValidationError) {
        return {
          status: "validation_error",
          message: error.message,
          issues: error.issues,
          nextAction: "Fix invalid model task inputs and retry.",
          category: "validation_error",
          errorCode: "validation.failed",
        };
      }
      throw error;
    }
  }

  makeApprovalGrant(
    effectClass: ApprovalGrant["effectClass"],
    targetId?: string,
    scope: ApprovalGrant["scope"] = "once",
  ): ApprovalGrant {
    return {
      scope,
      effectClass,
      targetId,
    };
  }

  addApprovedAdapter(name: string): void {
    this.approvedAdapters.add(name);
  }
}
