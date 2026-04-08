import path from "node:path";
import {
  ApprovalRequiredError,
  CapabilityNotFoundError,
  PolicyDeniedError,
  SessionNotFoundError,
  ValidationError,
  type ApprovalGrantRecord,
  type EffectClass,
  type GrantScope,
  type SessionRecord,
} from "@openharbor/core";
import {
  createHarborEnvironment,
  makeAuditEvent,
  type HarborEnvironment,
  type SessionOverview,
  type TestRunRecord,
} from "@openharbor/host";
import { type ApprovalGrant, resolvePolicyPreset, type PolicyPresetName } from "@openharbor/policy";

export interface ApprovalRequirement {
  effectClass: EffectClass;
  targetId: string;
  targetLabel?: string;
  scopeHint?: GrantScope;
  taskId?: string;
}

export type BridgeResult<T> =
  | { status: "ok"; data: T }
  | {
      status: "approval_required";
      message: string;
      reason?: string;
      nextAction?: string;
      approval: ApprovalRequirement;
    }
  | {
      status: "denied";
      message: string;
      reason?: string;
      nextAction?: string;
      targetLabel?: string;
    }
  | {
      status: "validation_error";
      message: string;
      issues: unknown;
      nextAction?: string;
    }
  | {
      status: "not_found";
      message: string;
      entity: "session" | "artifact" | "file" | "path";
    };

export interface HarborAgentBridgeOptions {
  dataDir?: string;
  approvedAdapters?: Iterable<string>;
  policyPreset?: PolicyPresetName | string;
}

export interface OpenSessionInput {
  repoPath?: string;
  sessionId?: string;
  name?: string;
  policyPreset?: PolicyPresetName | string;
}

export interface ListSessionsInput {
  repoPath?: string;
}

export interface SessionSummary {
  id: string;
  repoPath: string;
  name?: string;
  state: SessionRecord["state"];
  createdAt: string;
  updatedAt: string;
}

export class HarborAgentBridge {
  readonly env: HarborEnvironment;
  private readonly approvedAdapters: Set<string>;

  constructor(options: HarborAgentBridgeOptions = {}) {
    this.env = createHarborEnvironment({
      dataDir: options.dataDir,
      policyPreset: resolvePolicyPreset(options.policyPreset),
    });
    this.approvedAdapters = new Set(options.approvedAdapters ?? []);
  }

  listCapabilities(): string[] {
    return this.env.capabilities.listRegistered();
  }

  addApprovedAdapter(name: string): void {
    this.approvedAdapters.add(name);
  }

  async invokeCapability<T>(
    sessionId: string,
    capability: string,
    input: unknown,
    options?: {
      approvalGrants?: ApprovalGrant[];
      taskId?: string;
      notFoundEntity?: "session" | "artifact" | "file" | "path";
    },
  ): Promise<BridgeResult<T>> {
    return this.run(async () => this.env.invoke(sessionId, capability, input, {
      approvedAdapters: this.approvedAdapters,
      approvalGrants: options?.approvalGrants,
      taskId: options?.taskId,
    }) as Promise<T>, options?.notFoundEntity);
  }

  async openSession(input: OpenSessionInput): Promise<BridgeResult<SessionSummary>> {
    if (input.sessionId) {
      const session = await this.env.sessions.getSessionRecord(input.sessionId);
      if (!session) {
        return this.notFound(`Session not found: ${input.sessionId}`, "session");
      }
      return this.ok(toSessionSummary(session));
    }
    if (!input.repoPath) {
      return this.validationError(
        "openSession requires repoPath when sessionId is not provided",
        { repoPath: input.repoPath, sessionId: input.sessionId },
        "Provide a repository path or an existing session id.",
      );
    }
    const session = await this.env.sessions.createSession(path.resolve(input.repoPath), input.name);
    return this.ok(toSessionSummary(session));
  }

  async listSessions(input: ListSessionsInput = {}): Promise<BridgeResult<{ sessions: SessionSummary[] }>> {
    const sessions = await this.env.listSessions(input.repoPath ? path.resolve(input.repoPath) : undefined);
    return this.ok({ sessions: sessions.map(toSessionSummary) });
  }

  async getSessionOverview(input: { sessionId: string }): Promise<BridgeResult<SessionOverview>> {
    return this.run(async () => this.env.getSessionOverview(input.sessionId));
  }

  async readRepoFile(input: { sessionId: string; path: string }): Promise<BridgeResult<{ content: string }>> {
    return this.invoke("repo.readFile", input.sessionId, { path: input.path }, "file");
  }

  async listRepoTree(input: {
    sessionId: string;
    path?: string;
    maxDepth?: number;
  }): Promise<BridgeResult<{ rootPath: string; tree: string }>> {
    const rootPath = input.path ?? ".";
    const stat = await this.invoke<{
      exists: boolean;
      type?: "file" | "dir" | "other";
    }>("repo.stat", input.sessionId, { path: rootPath }, "path");
    if (stat.status !== "ok") {
      return stat;
    }
    if (stat.data.exists !== true) {
      return this.notFound(`Path not found: ${rootPath}`, "path");
    }

    const lines = [rootPath === "." ? "." : rootPath];
    if (stat.data.type === "dir" && input.maxDepth !== 0) {
      const appended = await this.appendRepoTreeLines(input.sessionId, rootPath, lines, "", 0, input.maxDepth);
      if (appended.status !== "ok") {
        return appended;
      }
    }
    return this.ok({ rootPath, tree: lines.join("\n") });
  }

  async searchRepo(input: {
    sessionId: string;
    query: string;
    path?: string;
    limit?: number;
  }): Promise<BridgeResult<{
    matches: Array<{ path: string; lineNumber: number; line: string }>;
    scannedFiles: number;
    truncated: boolean;
  }>> {
    return this.invoke("repo.search", input.sessionId, {
      query: input.query,
      path: input.path ?? ".",
      maxResults: input.limit ?? 100,
    });
  }

  async readDraftFile(input: { sessionId: string; path: string }): Promise<BridgeResult<{ content: string }>> {
    return this.invoke("workspace.readFile", input.sessionId, { path: input.path }, "file");
  }

  async writeDraftFile(input: {
    sessionId: string;
    path: string;
    content: string;
  }): Promise<BridgeResult<{ ok: true }>> {
    return this.invoke("workspace.writeFile", input.sessionId, {
      path: input.path,
      content: input.content,
    });
  }

  async deleteDraftPath(input: {
    sessionId: string;
    path: string;
    recursive?: boolean;
  }): Promise<BridgeResult<{ ok: true; deleted: number }>> {
    return this.invoke("workspace.deletePath", input.sessionId, {
      path: input.path,
      recursive: input.recursive ?? true,
    });
  }

  async diffDraft(input: { sessionId: string; path?: string }): Promise<BridgeResult<{
    files: Array<{
      path: string;
      hunks: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
    }>;
    summary: {
      fileCount: number;
      addedLines: number;
      removedLines: number;
    };
  }>> {
    const result = await this.invoke<{
      files: Array<{
        path: string;
        hunks: Array<{
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
          lines: string[];
        }>;
      }>;
    }>("workspace.diff", input.sessionId, {});
    if (result.status !== "ok") {
      return result;
    }
    const files = input.path
      ? result.data.files.filter((file) => file.path === input.path || file.path.startsWith(`${input.path}/`))
      : result.data.files;
    return this.ok({
      files,
      summary: {
        fileCount: files.length,
        addedLines: sumDiffLines(files, "+"),
        removedLines: sumDiffLines(files, "-"),
      },
    });
  }

  async runTests(input: {
    sessionId: string;
    adapter: string;
    args?: string[];
    timeoutMs?: number;
    taskId?: string;
  }): Promise<BridgeResult<{
    runId: string;
    adapter: string;
    ok: boolean;
    exitCode: number;
    timedOut: boolean;
    stdoutArtifactId?: string;
    stderrArtifactId?: string;
  }>> {
    return this.invoke("tests.run", input.sessionId, {
      adapter: input.adapter,
      args: input.args,
      timeoutMs: input.timeoutMs,
    }, undefined, input.taskId);
  }

  async listTestRuns(input: {
    sessionId: string;
    limit?: number;
  }): Promise<BridgeResult<{ runs: TestRunRecord[] }>> {
    return this.invoke("tests.listRuns", input.sessionId, { limit: input.limit ?? 20 });
  }

  async getArtifact(input: {
    sessionId: string;
    artifactId: string;
    asText?: boolean;
  }): Promise<BridgeResult<{
    artifactId: string;
    mimeType: string;
    createdAt: string;
    sizeBytes: number;
    content: string;
  }>> {
    const session = await this.env.sessions.getSessionRecord(input.sessionId);
    if (!session) {
      return this.notFound(`Session not found: ${input.sessionId}`, "session");
    }
    const artifact = await this.env.store.getArtifact(input.sessionId, input.artifactId);
    if (!artifact) {
      return this.notFound(`Artifact not found: ${input.artifactId}`, "artifact");
    }
    return this.ok({
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt,
      sizeBytes: artifact.sizeBytes,
      content: artifact.content,
    });
  }

  async listApprovals(input: {
    sessionId: string;
    includeInactive?: boolean;
  }): Promise<BridgeResult<{ grants: ApprovalGrantRecord[] }>> {
    const session = await this.env.sessions.getSessionRecord(input.sessionId);
    if (!session) {
      return this.notFound(`Session not found: ${input.sessionId}`, "session");
    }
    return this.ok({
      grants: this.env.sessions.listApprovalGrants(input.sessionId, {
        includeInactive: input.includeInactive ?? true,
      }),
    });
  }

  async grantApproval(input: {
    sessionId: string;
    effectClass: EffectClass;
    targetId: string;
    scope: GrantScope;
    taskId?: string;
  }): Promise<BridgeResult<{ granted: true; grantId: string }>> {
    const session = await this.env.sessions.getSessionRecord(input.sessionId);
    if (!session) {
      return this.notFound(`Session not found: ${input.sessionId}`, "session");
    }
    if (input.scope === "task" && !input.taskId) {
      return this.validationError(
        "Task-scoped approval requires taskId",
        input,
        "Provide taskId when granting task-scoped approval.",
      );
    }
    const issued = this.env.sessions.issueApprovalGrant({
      sessionId: input.sessionId,
      scope: input.scope,
      effectClass: input.effectClass,
      targetId: input.targetId,
      taskId: input.taskId,
    });
    await this.env.sessions.persistApprovalGrants(input.sessionId);
    await this.env.store.appendAudit(
      input.sessionId,
      makeAuditEvent(input.sessionId, "approval.granted", {
        grantId: issued.id,
        scope: issued.scope,
        effectClass: issued.effectClass,
        targetId: issued.targetId,
        taskId: issued.taskId ?? null,
        status: issued.status,
      }),
    );
    return this.ok({ granted: true, grantId: issued.id });
  }

  async revokeApproval(input: {
    sessionId: string;
    grantId?: string;
    taskId?: string;
    all?: boolean;
    reason?: string;
  }): Promise<BridgeResult<{ revokedCount: number; grantIds: string[] }>> {
    const session = await this.env.sessions.getSessionRecord(input.sessionId);
    if (!session) {
      return this.notFound(`Session not found: ${input.sessionId}`, "session");
    }

    const selectors = [input.grantId ? 1 : 0, input.taskId ? 1 : 0, input.all ? 1 : 0]
      .reduce((sum, item) => sum + item, 0);
    if (selectors !== 1) {
      return this.validationError(
        "Exactly one of grantId, taskId, or all=true is required",
        input,
        "Choose a single approval revocation selector and retry.",
      );
    }

    let revoked: ApprovalGrantRecord[] = [];
    if (input.grantId) {
      const hit = this.env.sessions.revokeApprovalGrant(input.sessionId, input.grantId, input.reason);
      revoked = hit ? [hit] : [];
    } else if (input.taskId) {
      revoked = this.env.sessions.revokeApprovalGrantsByTask(input.sessionId, input.taskId, input.reason);
    } else if (input.all) {
      revoked = this.env.sessions.revokeAllApprovalGrants(input.sessionId, input.reason);
    }

    await this.env.sessions.persistApprovalGrants(input.sessionId);
    for (const grant of revoked) {
      await this.env.store.appendAudit(
        input.sessionId,
        makeAuditEvent(input.sessionId, "approval.revoked", {
          grantId: grant.id,
          reason: input.reason ?? null,
        }),
      );
    }
    return this.ok({ revokedCount: revoked.length, grantIds: revoked.map((grant) => grant.id) });
  }

  async publishPreview(input: { sessionId: string }): Promise<BridgeResult<{ changeCount: number; paths: string[] }>> {
    return this.invoke("publish.preview", input.sessionId, {});
  }

  async publishApply(input: {
    sessionId: string;
    resetOverlay?: boolean;
  }): Promise<BridgeResult<{ published: true; changeCount: number; paths: string[] }>> {
    return this.invoke("publish.apply", input.sessionId, { resetOverlay: input.resetOverlay ?? true });
  }

  async discardDraft(input: {
    sessionId: string;
    paths?: string[];
  }): Promise<BridgeResult<{ discarded: true }>> {
    return this.invoke("review.discard", input.sessionId, { paths: input.paths });
  }

  async reviseReview(input: { sessionId: string; note: string }): Promise<BridgeResult<{ revised: true }>> {
    return this.invoke("review.revise", input.sessionId, { note: input.note });
  }

  async rejectPublish(input: { sessionId: string; reason: string }): Promise<BridgeResult<{ rejected: true }>> {
    return this.invoke("review.reject", input.sessionId, { reason: input.reason });
  }

  async runModelTask(input: {
    sessionId: string;
    code: string;
    taskId?: string;
    limits?: {
      timeoutMs?: number;
      maxOutputChars?: number;
      maxCodeUnits?: number;
      maxHeapBytes?: number;
    };
    approvalGrants?: ApprovalGrant[];
  }): Promise<BridgeResult<{
    modelRunId: string;
    ok: boolean;
    value?: unknown;
    error?: string;
    timedOut: boolean;
    durationMs: number;
    stdoutArtifactId?: string;
    stderrArtifactId?: string;
    truncatedOutput: boolean;
  }>> {
    return this.run(async () => this.env.runModelTask(input.sessionId, input.code, {
      taskId: input.taskId,
      limits: input.limits,
      policyOverrides: {
        taskId: input.taskId,
        approvalGrants: input.approvalGrants,
        approvedAdapters: this.approvedAdapters,
      },
    }));
  }

  private async appendRepoTreeLines(
    sessionId: string,
    targetPath: string,
    lines: string[],
    prefix: string,
    depth: number,
    maxDepth?: number,
  ): Promise<BridgeResult<{ ok: true }>> {
    const listed = await this.invoke<{
      entries: Array<{ name: string; path: string; type: string }>;
    }>("repo.listDir", sessionId, { path: targetPath }, "path");
    if (listed.status !== "ok") {
      return listed;
    }

    for (let index = 0; index < listed.data.entries.length; index += 1) {
      const entry = listed.data.entries[index];
      const isLast = index === listed.data.entries.length - 1;
      lines.push(`${prefix}${isLast ? "\\-" : "|-"} ${entry.name}`);
      if (entry.type === "dir" && (maxDepth === undefined || depth + 1 < maxDepth)) {
        const nested = await this.appendRepoTreeLines(
          sessionId,
          entry.path,
          lines,
          `${prefix}${isLast ? "   " : "|  "}`,
          depth + 1,
          maxDepth,
        );
        if (nested.status !== "ok") {
          return nested;
        }
      }
    }

    return this.ok({ ok: true as const });
  }

  private async invoke<T>(
    capability: string,
    sessionId: string,
    input: unknown,
    notFoundEntity?: "session" | "artifact" | "file" | "path",
    taskId?: string,
  ): Promise<BridgeResult<T>> {
    return this.invokeCapability(sessionId, capability, input, { notFoundEntity, taskId });
  }

  private async run<T>(
    fn: () => Promise<T>,
    notFoundEntity?: "session" | "artifact" | "file" | "path",
  ): Promise<BridgeResult<T>> {
    try {
      return this.ok(await fn());
    } catch (error) {
      return this.mapError(error, notFoundEntity);
    }
  }

  private mapError<T>(
    error: unknown,
    notFoundEntity?: "session" | "artifact" | "file" | "path",
  ): BridgeResult<T> {
    if (error instanceof ApprovalRequiredError) {
      return {
        status: "approval_required",
        message: error.message,
        reason: error.record.reason,
        nextAction: error.record.nextAction,
        approval: {
          effectClass: error.record.effectClass ?? "publish.repo",
          targetId: error.record.targetId ?? "*",
          targetLabel: error.record.targetLabel,
          scopeHint: error.record.grantScopeHint,
        },
      };
    }
    if (error instanceof PolicyDeniedError) {
      return {
        status: "denied",
        message: error.message,
        reason: error.record.reason,
        nextAction: error.record.nextAction,
        targetLabel: error.record.targetLabel,
      };
    }
    if (error instanceof ValidationError) {
      return this.validationError(error.message, error.issues, "Fix invalid input and retry.");
    }
    if (error instanceof CapabilityNotFoundError) {
      return this.validationError(
        error.message,
        { capabilityName: error.capabilityName },
        "Choose a registered Harbor capability and retry.",
      );
    }
    if (error instanceof SessionNotFoundError) {
      return this.notFound(error.message, "session");
    }
    if (isNodeError(error) && error.code === "ENOENT" && notFoundEntity) {
      return this.notFound(error.message, notFoundEntity);
    }
    const message = error instanceof Error ? error.message : "Unexpected Harbor bridge error";
    return this.validationError(message, { error: String(error) });
  }

  private ok<T>(data: T): BridgeResult<T> {
    return { status: "ok", data };
  }

  private validationError<T>(message: string, issues: unknown, nextAction?: string): BridgeResult<T> {
    return { status: "validation_error", message, issues, nextAction };
  }

  private notFound<T>(
    message: string,
    entity: "session" | "artifact" | "file" | "path",
  ): BridgeResult<T> {
    return { status: "not_found", message, entity };
  }
}

export function createHarborAgentBridge(options: HarborAgentBridgeOptions = {}): HarborAgentBridge {
  return new HarborAgentBridge(options);
}

function toSessionSummary(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    repoPath: session.repoPath,
    name: session.name,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function sumDiffLines(
  files: Array<{ hunks: Array<{ lines: string[] }> }>,
  prefix: "+" | "-",
): number {
  let total = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
          total += 1;
        }
      }
    }
  }
  return total;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}
