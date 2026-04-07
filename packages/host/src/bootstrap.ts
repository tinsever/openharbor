import { randomUUID } from "node:crypto";
import type { ApprovalGrant } from "@openharbor/policy";
import { approvalGrantKey } from "@openharbor/policy";
import { createDefaultPolicyEngine } from "@openharbor/policy";
import { createHarborRuntime, type HarborRuntimeLimits } from "@openharbor/runtime";
import { defaultDataDir } from "./paths.js";
import { LocalHarborStore } from "./local-store.js";
import { SessionManager } from "./session-manager.js";
import { CapabilityHost, type InvokeContext } from "./capability-host.js";
import { makeAuditEvent } from "./audit.js";
import { registerBuiltinCapabilities } from "./builtins.js";

export interface HarborEnvironment {
  readonly dataDir: string;
  readonly store: LocalHarborStore;
  readonly sessions: SessionManager;
  readonly capabilities: CapabilityHost;
  invoke(
    sessionId: string,
    capabilityName: string,
    input: unknown,
    policyOverrides?: InvokePolicyOverrides,
  ): Promise<unknown>;
  runModelTask(
    sessionId: string,
    code: string,
    options?: RunModelTaskOptions,
  ): Promise<RunModelTaskResult>;
}

export interface InvokePolicyOverrides {
  approvedAdapters?: Set<string>;
  approvalGrants?: ApprovalGrant[];
  taskId?: string;
}

export interface RunModelTaskOptions {
  taskId?: string;
  limits?: HarborRuntimeLimits;
  policyOverrides?: InvokePolicyOverrides;
}

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

export function createHarborEnvironment(dataDir: string = defaultDataDir()): HarborEnvironment {
  const store = new LocalHarborStore({ dataDir });
  const policy = createDefaultPolicyEngine();
  const sessions = new SessionManager(store);
  const capabilities = new CapabilityHost(policy, store);
  const runtime = createHarborRuntime();
  registerBuiltinCapabilities(capabilities);

  return {
    dataDir,
    store,
    sessions,
    capabilities,
    invoke: (sessionId, capabilityName, input, policyOverrides) =>
      invokeCapability(sessions, capabilities, sessionId, capabilityName, input, policyOverrides),
    runModelTask: (sessionId, code, options) =>
      runModelTask(sessions, capabilities, runtime, sessionId, code, options),
  };
}

async function runModelTask(
  sessions: SessionManager,
  capabilities: CapabilityHost,
  runtime: ReturnType<typeof createHarborRuntime>,
  sessionId: string,
  code: string,
  options?: RunModelTaskOptions,
): Promise<RunModelTaskResult> {
  const modelRunId = randomUUID();
  await sessions.getBundle(sessionId);

  await sessions.store.appendAudit(
    sessionId,
    makeAuditEvent(sessionId, "model_run.started", {
      modelRunId,
      taskId: options?.taskId ?? null,
    }),
  );

  const result = await runtime.execute({
    code,
    filename: `session-${sessionId}.js`,
    limits: options?.limits,
    bridge: {
      invoke: async (capabilityName, input) =>
        invokeCapability(
          sessions,
          capabilities,
          sessionId,
          capabilityName,
          input,
          {
            ...options?.policyOverrides,
            taskId: options?.taskId ?? options?.policyOverrides?.taskId,
          },
        ),
    },
  });

  const out: RunModelTaskResult = {
    modelRunId,
    ok: result.ok,
    value: result.value,
    error: result.error,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncatedOutput: result.truncatedOutput,
  };

  if (result.stdout.length > 0) {
    const stdoutArtifactId = randomUUID();
    await sessions.store.putArtifact(sessionId, {
      id: stdoutArtifactId,
      mimeType: "text/plain",
      content: result.stdout,
    });
    out.stdoutArtifactId = stdoutArtifactId;
  }

  if (result.stderr.length > 0) {
    const stderrArtifactId = randomUUID();
    await sessions.store.putArtifact(sessionId, {
      id: stderrArtifactId,
      mimeType: "text/plain",
      content: result.stderr,
    });
    out.stderrArtifactId = stderrArtifactId;
  }

  await sessions.store.appendAudit(
    sessionId,
    makeAuditEvent(sessionId, result.ok ? "model_run.completed" : "model_run.failed", {
      modelRunId,
      taskId: options?.taskId ?? null,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      truncatedOutput: result.truncatedOutput,
      stdoutArtifactId: out.stdoutArtifactId ?? null,
      stderrArtifactId: out.stderrArtifactId ?? null,
      error: result.error ?? null,
    }),
  );

  return out;
}

async function invokeCapability(
  sessions: SessionManager,
  capabilities: CapabilityHost,
  sessionId: string,
  capabilityName: string,
  input: unknown,
  policyOverrides?: InvokePolicyOverrides,
): Promise<unknown> {
  const bundle = await sessions.getBundle(sessionId);
  const onceGrantKeys = new Set<string>();
  for (const grant of policyOverrides?.approvalGrants ?? []) {
    const key = approvalGrantKey(grant.effectClass, grant.targetId ?? "*");
    await sessions.store.appendAudit(
      sessionId,
      makeAuditEvent(sessionId, "approval.granted", {
        scope: grant.scope,
        effectClass: grant.effectClass,
        targetId: grant.targetId ?? null,
        taskId: policyOverrides?.taskId ?? null,
      }),
    );
    if (grant.scope === "once") {
      onceGrantKeys.add(key);
      continue;
    }
    if (grant.scope === "task") {
      if (!policyOverrides?.taskId) {
        continue;
      }
      sessions.addTaskApprovalGrant(sessionId, policyOverrides.taskId, key);
      continue;
    }
    sessions.addSessionApprovalGrant(sessionId, key);
  }

  const ctx: InvokeContext = {
    session: bundle.session,
    overlay: bundle.overlay,
    store: sessions.store,
    policyContext: {
      sessionId,
      approvedAdapters: policyOverrides?.approvedAdapters ?? new Set(),
      approvalGrantsOnce: onceGrantKeys,
      approvalGrantsTask: sessions.getTaskApprovalGrants(sessionId, policyOverrides?.taskId),
      approvalGrantsSession: sessions.getSessionApprovalGrants(sessionId),
    },
    persistWorkspace: () => sessions.persistOverlay(sessionId),
    consumeApprovalGrantOnce: async (grantKey: string) => {
      onceGrantKeys.delete(grantKey);
    },
  };
  return capabilities.invoke(capabilityName, input, ctx);
}
