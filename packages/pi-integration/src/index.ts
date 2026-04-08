import {
  createHarborAgentBridge,
  type BridgeResult,
  type HarborAgentBridge,
  type HarborAgentBridgeOptions,
} from "@openharbor/agent-bridge";
import { resolvePolicyPreset, type ApprovalGrant } from "@openharbor/policy";

export interface PiIntegrationOptions extends HarborAgentBridgeOptions {}

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
    }
  | {
      status: "not_found";
      message: string;
      entity: "session" | "artifact" | "file" | "path";
      category?: string;
      errorCode?: string;
    };

export type PiRunModelTaskResult =
  | {
      status: "ok";
      value: RunModelTaskResult;
    }
  | Exclude<PiInvokeResult, { status: "ok" }>;

export interface RunModelTaskResult {
  modelRunId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  timedOut: boolean;
  durationMs: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  truncatedOutput: boolean;
}

export interface RunModelTaskOptions {
  taskId?: string;
  limits?: {
    timeoutMs?: number;
    maxOutputChars?: number;
    maxCodeUnits?: number;
    maxHeapBytes?: number;
  };
}

export interface HarborSessionSummary {
  id: string;
  repoPath: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Deprecated compatibility bridge for Pi-hosted UX surfaces.
 * New integrations should target @openharbor/agent-bridge or the Harbor MCP server.
 */
export class PiHarborBridge {
  readonly bridge: HarborAgentBridge;

  constructor(opts: PiIntegrationOptions = {}) {
    this.bridge = createHarborAgentBridge({
      dataDir: opts.dataDir,
      approvedAdapters: opts.approvedAdapters,
      policyPreset: resolvePolicyPreset(opts.policyPreset),
    });
  }

  get env() {
    return this.bridge.env;
  }

  listCapabilities(): string[] {
    return this.bridge.listCapabilities();
  }

  async createSession(repoPath: string, name?: string): Promise<HarborSessionSummary> {
    const result = await this.bridge.openSession({ repoPath, name });
    if (result.status !== "ok") {
      throw new Error(`Expected ok result when creating session, got ${result.status}`);
    }
    return result.data;
  }

  async invoke(req: InvokeRequest): Promise<PiInvokeResult> {
    if (!this.bridge.listCapabilities().includes(req.capability)) {
      return {
        status: "validation_error",
        message: `Unknown capability: ${req.capability}`,
        issues: { capabilityName: req.capability },
        nextAction: "Choose a capability from `harbor caps` and retry.",
        category: "capability_error",
        errorCode: "capability.not_found",
      };
    }
    const result = await this.bridge.invokeCapability(req.sessionId, req.capability, req.input, {
      approvalGrants: req.approvalGrants,
      taskId: req.taskId,
    });
    return toPiResult(result);
  }

  async runModelTask(
    sessionId: string,
    code: string,
    options?: Omit<RunModelTaskOptions, "policyOverrides"> & {
      approvalGrants?: ApprovalGrant[];
      taskId?: string;
    },
  ): Promise<PiRunModelTaskResult> {
    const result = await this.bridge.runModelTask({
      sessionId,
      code,
      limits: options?.limits,
      taskId: options?.taskId,
      approvalGrants: options?.approvalGrants,
    });
    return result.status === "ok"
      ? { status: "ok", value: result.data }
      : (toPiResult(result) as PiRunModelTaskResult);
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
    this.bridge.addApprovedAdapter(name);
  }
}

function toPiResult(result: BridgeResult<unknown>): PiInvokeResult {
  if (result.status === "ok") {
    return { status: "ok", value: result.data };
  }
  if (result.status === "approval_required") {
    return {
      status: "approval_required",
      message: result.message,
      intent: result.message,
      reason: result.reason,
      nextAction: result.nextAction,
      grantScopeHint: result.approval.scopeHint,
      targetLabel: result.approval.targetLabel,
      category: "approval_required",
      errorCode: "approval.required",
    };
  }
  if (result.status === "denied") {
    return {
      status: "denied",
      message: result.message,
      reason: result.reason,
      nextAction: result.nextAction,
      targetLabel: result.targetLabel,
      category: "policy_denied",
      errorCode: "policy.denied",
    };
  }
  if (result.status === "not_found") {
    return {
      status: "not_found",
      message: result.message,
      entity: result.entity,
      category: "not_found",
      errorCode: "resource.not_found",
    };
  }
  return {
    status: "validation_error",
    message: result.message,
    issues: result.issues,
    nextAction: result.nextAction,
    category: "validation_error",
    errorCode: "validation.failed",
  };
}
