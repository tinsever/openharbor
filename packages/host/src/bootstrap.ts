import { randomUUID } from "node:crypto";
import { ValidationError } from "@openharbor/core";
import type { ApprovalGrant } from "@openharbor/policy";
import {
  createPolicyEngine,
  resolvePolicyPreset,
  type PolicyPresetName,
} from "@openharbor/policy";
import { createHarborRuntime, type HarborRuntimeLimits } from "@openharbor/runtime";
import { defaultDataDir } from "./paths.js";
import { LocalHarborStore } from "./local-store.js";
import { SessionManager } from "./session-manager.js";
import { CapabilityHost, type InvokeContext } from "./capability-host.js";
import type { RegisteredCapabilityPack } from "./capability-packs.js";
import { registerDefaultCapabilityPacks } from "./packs/index.js";
import { makeAuditEvent } from "./audit.js";

export interface HarborEnvironment {
  readonly dataDir: string;
  readonly store: LocalHarborStore;
  readonly sessions: SessionManager;
  readonly capabilities: CapabilityHost;
  readonly capabilityPacks: RegisteredCapabilityPack[];
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

export interface HarborEnvironmentOptions {
  dataDir?: string;
  policyPreset?: PolicyPresetName | string;
}

export function createHarborEnvironment(
  options: string | HarborEnvironmentOptions = {},
): HarborEnvironment {
  const resolvedOptions = normalizeEnvironmentOptions(options);
  const dataDir = resolvedOptions.dataDir ?? defaultDataDir();
  const policyPreset = resolvePolicyPreset(resolvedOptions.policyPreset);

  const store = new LocalHarborStore({ dataDir });
  const policy = createPolicyEngine(policyPreset);
  const sessions = new SessionManager(store);
  const capabilities = new CapabilityHost(policy, store);
  const runtime = createHarborRuntime();
  const capabilityPacks = registerDefaultCapabilityPacks(capabilities);

  return {
    dataDir,
    store,
    sessions,
    capabilities,
    capabilityPacks,
    invoke: (sessionId, capabilityName, input, policyOverrides) =>
      invokeCapability(sessions, capabilities, sessionId, capabilityName, input, policyOverrides),
    runModelTask: (sessionId, code, options) =>
      runModelTask(sessions, capabilities, runtime, sessionId, code, options),
  };
}

function normalizeEnvironmentOptions(
  options: string | HarborEnvironmentOptions,
): HarborEnvironmentOptions {
  if (typeof options === "string") {
    return { dataDir: options };
  }
  return options;
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
  for (const grant of policyOverrides?.approvalGrants ?? []) {
    if (grant.scope === "task" && !policyOverrides?.taskId) {
      throw new ValidationError(
        "Task-scoped approval grant requires taskId",
        { scope: grant.scope, effectClass: grant.effectClass, targetId: grant.targetId ?? "*" },
      );
    }
    const targetId = grant.targetId ?? "*";
    const issued = sessions.issueApprovalGrant({
      sessionId,
      scope: grant.scope,
      effectClass: grant.effectClass,
      targetId,
      taskId: grant.scope === "task" ? policyOverrides?.taskId : undefined,
    });
    await sessions.persistApprovalGrants(sessionId);
    await sessions.store.appendAudit(
      sessionId,
      makeAuditEvent(sessionId, "approval.granted", {
        grantId: issued.id,
        scope: grant.scope,
        effectClass: grant.effectClass,
        targetId,
        taskId: policyOverrides?.taskId ?? null,
        status: issued.status,
      }),
    );
  }

  const grantKeySets = sessions.getPolicyGrantKeySets(sessionId, policyOverrides?.taskId);

  const ctx: InvokeContext = {
    session: bundle.session,
    overlay: bundle.overlay,
    store: sessions.store,
    sessions,
    policyContext: {
      sessionId,
      approvedAdapters: policyOverrides?.approvedAdapters ?? new Set(),
      approvalGrantsOnce: grantKeySets.approvalGrantsOnce,
      approvalGrantsTask: grantKeySets.approvalGrantsTask,
      approvalGrantsSession: grantKeySets.approvalGrantsSession,
    },
    persistWorkspace: () => sessions.persistOverlay(sessionId),
    consumeApprovalGrantOnce: async (grantKey: string) => {
      const consumed = sessions.consumeOnceGrantByKey(sessionId, grantKey);
      if (!consumed) {
        return;
      }
      await sessions.persistApprovalGrants(sessionId);
      await sessions.store.appendAudit(
        sessionId,
        makeAuditEvent(sessionId, "approval.used", {
          grantId: consumed.id,
          scope: consumed.scope,
          effectClass: consumed.effectClass,
          targetId: consumed.targetId,
          taskId: consumed.taskId ?? null,
          status: consumed.status,
        }),
      );
    },
  };
  return capabilities.invoke(capabilityName, input, ctx);
}
