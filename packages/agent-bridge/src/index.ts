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

export interface PublishPreview {
  changeCount: number;
  paths: string[];
  files: Array<{
    path: string;
    hunkCount: number;
    addedLines: number;
    removedLines: number;
    previewLines: string[];
  }>;
  summary: {
    fileCount: number;
    addedLines: number;
    removedLines: number;
  };
}

export interface FileReadResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  returnedLineCount: number;
  truncated: boolean;
  nextStartLine?: number;
}

export interface OpenSessionSummary extends SessionSummary {
  guide: HarborWorkflowGuide;
}

export interface RepoSearchResult {
  query: string;
  searchPath: string;
  matches: Array<{ path: string; lineNumber: number; line: string }>;
  scannedFiles: number;
  truncated: boolean;
  files: Array<{
    path: string;
    matchCount: number;
    firstMatchLineNumber: number;
    firstMatchLine: string;
  }>;
  suggestedPaths: string[];
  recommendedScopes: string[];
}

export interface TestAdapterSummary {
  name: string;
  command: string;
  args: string[];
  description: string;
}

export interface HarborSuggestedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface HarborWorkflowGuide {
  scope: "global" | "repo" | "session";
  phase: "start" | "resume" | "inspect" | "draft" | "validate" | "repair" | "publish";
  summary: string;
  recommendedNextStep: string;
  whyThisStep: string;
  currentState: {
    repoPath?: string;
    sessionId?: string;
    existingSessionIds?: string[];
    draftChangeCount?: number;
    publishChangeCount?: number;
    lastTestStatus?: "not_run" | "passed" | "failed";
    lastTestAdapter?: string;
    activeApprovalCount?: number;
    availableAdapters?: string[];
  };
  primaryAction: HarborSuggestedToolCall;
  suggestedCalls: HarborSuggestedToolCall[];
  checklist: string[];
  approvalFlow: {
    summary: string;
    steps: string[];
  };
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

  async openSession(input: OpenSessionInput): Promise<BridgeResult<OpenSessionSummary>> {
    if (input.sessionId) {
      const session = await this.env.sessions.getSessionRecord(input.sessionId);
      if (!session) {
        return this.notFound(`Session not found: ${input.sessionId}`, "session");
      }
      return this.ok(await this.toOpenSessionSummary(session));
    }
    if (!input.repoPath) {
      return this.validationError(
        "openSession requires repoPath when sessionId is not provided",
        { repoPath: input.repoPath, sessionId: input.sessionId },
        "Provide a repository path or an existing session id.",
      );
    }
    const session = await this.env.sessions.createSession(path.resolve(input.repoPath), input.name);
    return this.ok(await this.toOpenSessionSummary(session));
  }

  async listSessions(input: ListSessionsInput = {}): Promise<BridgeResult<{ sessions: SessionSummary[] }>> {
    const sessions = await this.env.listSessions(input.repoPath ? path.resolve(input.repoPath) : undefined);
    return this.ok({ sessions: sessions.map(toSessionSummary) });
  }

  async getSessionOverview(input: { sessionId: string }): Promise<BridgeResult<SessionOverview>> {
    return this.run(async () => this.env.getSessionOverview(input.sessionId));
  }

  async listTestAdapters(input: { sessionId: string }): Promise<BridgeResult<{ adapters: TestAdapterSummary[] }>> {
    return this.invoke("tests.listAdapters", input.sessionId, {});
  }

  async getWorkflowGuide(input: {
    sessionId?: string;
    repoPath?: string;
  }): Promise<BridgeResult<HarborWorkflowGuide>> {
    if (input.sessionId) {
      const session = await this.env.sessions.getSessionRecord(input.sessionId);
      if (!session) {
        return this.notFound(`Session not found: ${input.sessionId}`, "session");
      }

      const overview = await this.getSessionOverview({ sessionId: input.sessionId });
      if (overview.status !== "ok") {
        return overview;
      }

      const adapters = await this.listTestAdapters({ sessionId: input.sessionId });
      const availableAdapters = adapters.status === "ok" ? adapters.data.adapters : [];
      return this.ok(buildSessionWorkflowGuide(session, overview.data, availableAdapters));
    }

    if (input.repoPath) {
      const repoPath = path.resolve(input.repoPath);
      const sessions = await this.env.listSessions(repoPath);
      return this.ok(buildRepoWorkflowGuide(repoPath, sessions));
    }

    return this.ok(buildGlobalWorkflowGuide());
  }

  async startHere(input: {
    sessionId?: string;
    repoPath?: string;
  }): Promise<BridgeResult<HarborWorkflowGuide>> {
    if (input.sessionId) {
      return this.getWorkflowGuide(input);
    }

    if (input.repoPath) {
      const repoPath = path.resolve(input.repoPath);
      const sessions = await this.env.listSessions(repoPath);
      if (sessions.length === 1) {
        return this.getWorkflowGuide({ sessionId: sessions[0]!.id });
      }
      return this.ok(buildRepoWorkflowGuide(repoPath, sessions));
    }

    const sessions = await this.env.listSessions();
    if (sessions.length === 1) {
      return this.getWorkflowGuide({ sessionId: sessions[0]!.id });
    }
    return this.ok(buildGlobalWorkflowGuide());
  }

  async readRepoFile(input: {
    sessionId: string;
    path: string;
    startLine?: number;
    maxLines?: number;
  }): Promise<BridgeResult<FileReadResult>> {
    const result = await this.invoke<{ content: string }>("repo.readFile", input.sessionId, { path: input.path }, "file");
    if (result.status !== "ok") {
      return result;
    }
    return this.ok(sliceFileContent(input.path, result.data.content, input.startLine, input.maxLines));
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
  }): Promise<BridgeResult<RepoSearchResult>> {
    const result = await this.invoke<{
      matches: Array<{ path: string; lineNumber: number; line: string }>;
      scannedFiles: number;
      truncated: boolean;
    }>("repo.search", input.sessionId, {
      query: input.query,
      path: input.path ?? ".",
      maxResults: input.limit ?? 100,
    });
    if (result.status !== "ok") {
      return result;
    }

    const fileMap = new Map<string, RepoSearchResult["files"][number]>();
    for (const match of result.data.matches) {
      const existing = fileMap.get(match.path);
      if (existing) {
        existing.matchCount += 1;
        continue;
      }
      fileMap.set(match.path, {
        path: match.path,
        matchCount: 1,
        firstMatchLineNumber: match.lineNumber,
        firstMatchLine: match.line,
      });
    }

    let files = [...fileMap.values()]
      .sort((a, b) => {
        const scoreDelta = scoreRepoSearchPath(b.path, input.query, b.matchCount)
          - scoreRepoSearchPath(a.path, input.query, a.matchCount);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        if (b.matchCount !== a.matchCount) {
          return b.matchCount - a.matchCount;
        }
        return a.path.localeCompare(b.path);
      });

    const visibleFiles = files.filter((file) => !isRepoNoisePath(file.path));
    if (visibleFiles.length > 0) {
      files = visibleFiles;
    }

    const visiblePaths = new Set(files.map((file) => file.path));
    const matches = result.data.matches.filter((match) => visiblePaths.has(match.path));

    return this.ok({
      query: input.query,
      searchPath: input.path ?? ".",
      ...result.data,
      matches,
      files,
      suggestedPaths: files.slice(0, 3).map((file) => file.path),
      recommendedScopes: collectSuggestedSearchScopes(files, input.path ?? "."),
    });
  }

  async readDraftFile(input: {
    sessionId: string;
    path: string;
    startLine?: number;
    maxLines?: number;
  }): Promise<BridgeResult<FileReadResult>> {
    const result = await this.invoke<{ content: string }>("workspace.readFile", input.sessionId, { path: input.path }, "file");
    if (result.status !== "ok") {
      return result;
    }
    return this.ok(sliceFileContent(input.path, result.data.content, input.startLine, input.maxLines));
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

  async publishPreview(input: { sessionId: string }): Promise<BridgeResult<PublishPreview>> {
    const preview = await this.invoke<{
      changeCount: number;
      paths: string[];
      files: Array<{
        path: string;
        hunkCount: number;
        addedLines: number;
        removedLines: number;
      }>;
      summary: {
        fileCount: number;
        addedLines: number;
        removedLines: number;
      };
    }>("publish.preview", input.sessionId, {});
    if (preview.status !== "ok") {
      return preview;
    }

    const diff = await this.diffDraft({ sessionId: input.sessionId });
    const diffFiles = diff.status === "ok"
      ? new Map(diff.data.files.map((file) => [file.path, file]))
      : new Map<string, {
          path: string;
          hunks: Array<{
            oldStart: number;
            oldLines: number;
            newStart: number;
            newLines: number;
            lines: string[];
          }>;
        }>()
      ;

    return this.ok({
      ...preview.data,
      files: preview.data.files.map((file) => ({
        ...file,
        previewLines: collectPreviewLines(diffFiles.get(file.path)),
      })),
    });
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

    const entries = listed.data.entries.filter((entry) => !shouldHideTreeEntry(targetPath, entry.path));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const isLast = index === entries.length - 1;
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

  private async toOpenSessionSummary(session: SessionRecord): Promise<OpenSessionSummary> {
    const overview = await this.getSessionOverview({ sessionId: session.id });
    const adapters = await this.listTestAdapters({ sessionId: session.id });
    const availableAdapters = adapters.status === "ok" ? adapters.data.adapters : [];
    const guide = overview.status === "ok"
      ? buildSessionWorkflowGuide(session, overview.data, availableAdapters)
      : buildRepoWorkflowGuide(session.repoPath, [session]);

    return {
      ...toSessionSummary(session),
      guide,
    };
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

const REPO_NOISE_SEGMENTS = new Set([
  ".git",
  ".harbor-data",
  ".pnpm-store",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "dist",
  "node_modules",
]);

const SOURCE_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

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

function buildGlobalWorkflowGuide(): HarborWorkflowGuide {
  const suggestedCalls: HarborSuggestedToolCall[] = [
    {
      tool: "harbor_list_sessions",
      arguments: {},
      reason: "Resume prior work if a Harbor session already exists.",
    },
    {
      tool: "harbor_open_session",
      arguments: { repoPath: "/absolute/path/to/repo" },
      reason: "Create a session for a repository when none exists yet.",
    },
    {
      tool: "harbor_get_guide",
      arguments: { sessionId: "<session-id>" },
      reason: "Once you have a session, ask Harbor for the session-specific next step.",
    },
  ];
  return {
    scope: "global",
    phase: "start",
    summary:
      "Harbor works best as a structured repo workflow: open or resume a session, inspect the repo, draft changes in the overlay, run tests, then publish with explicit approval.",
    recommendedNextStep:
      "Start by resuming an existing session with `harbor_list_sessions` or creating one with `harbor_open_session`.",
    whyThisStep:
      "Harbor cannot inspect or edit anything until work is anchored to a session, so the first UX decision is always resume versus create.",
    currentState: {},
    primaryAction: suggestedCalls[0]!,
    suggestedCalls,
    checklist: [
      "If a relevant session already exists, resume it instead of creating another one.",
      "If no session exists, create one with an absolute repository path.",
      "After you have a session id, switch to the session-specific guide.",
    ],
    approvalFlow: buildApprovalFlow(),
  };
}

function buildRepoWorkflowGuide(
  repoPath: string,
  sessions: SessionRecord[],
): HarborWorkflowGuide {
  if (sessions.length === 0) {
    const suggestedCalls: HarborSuggestedToolCall[] = [
      {
        tool: "harbor_open_session",
        arguments: { repoPath },
        reason: "Create the first Harbor session for this repository.",
      },
      {
        tool: "harbor_list_sessions",
        arguments: { repoPath },
        reason: "Re-check whether another client has already created a session.",
      },
    ];
    return {
      scope: "repo",
      phase: "start",
      summary: "No Harbor session exists for this repository yet.",
      recommendedNextStep:
        "Create a Harbor session for this repo, then inspect the tree and start drafting changes in the overlay.",
      whyThisStep:
        "A repo-scoped request already tells Harbor where to work, so the shortest path is to create the session immediately.",
      currentState: {
        repoPath,
        existingSessionIds: [],
      },
      primaryAction: suggestedCalls[0]!,
      suggestedCalls,
      checklist: [
        "Create the session for this repository.",
        "Use the returned session id for all subsequent Harbor calls.",
        "Inspect the repo before writing into the draft overlay.",
      ],
      approvalFlow: buildApprovalFlow(),
    };
  }

  const latest = sessions[0]!;
  const suggestedCalls: HarborSuggestedToolCall[] = [
    {
      tool: "harbor_open_session",
      arguments: { sessionId: latest.id },
      reason: "Resume the most recently updated session for this repository.",
    },
    {
      tool: "harbor_get_guide",
      arguments: { sessionId: latest.id },
      reason: "See the next recommended Harbor action for the resumed session.",
    },
    {
      tool: "harbor_list_sessions",
      arguments: { repoPath },
      reason: "Inspect all stored sessions if you need a different branch of work.",
    },
  ];
  return {
    scope: "repo",
    phase: "resume",
    summary: `This repository already has ${sessions.length} Harbor session${sessions.length === 1 ? "" : "s"}.`,
    recommendedNextStep:
      "Resume the latest session instead of starting from scratch, then ask Harbor for the session-specific workflow guide.",
    whyThisStep:
      "Reusing the active session preserves draft state, test history, and approvals instead of fragmenting work across sessions.",
    currentState: {
      repoPath,
      existingSessionIds: sessions.map((session) => session.id),
      sessionId: latest.id,
    },
    primaryAction: suggestedCalls[0]!,
    suggestedCalls,
    checklist: [
      "Resume the latest session unless you have a reason to branch work.",
      "Refresh the session-specific guide after opening it.",
      "Only inspect the full session list if the latest one is not the right context.",
    ],
    approvalFlow: buildApprovalFlow(),
  };
}

function buildSessionWorkflowGuide(
  session: SessionRecord,
  overview: SessionOverview,
  adapters: TestAdapterSummary[],
): HarborWorkflowGuide {
  const latestRun = overview.tests.recentRuns[0];
  const lastTestStatus = latestRun ? (latestRun.ok ? "passed" : "failed") : "not_run";
  const currentState: HarborWorkflowGuide["currentState"] = {
    repoPath: session.repoPath,
    sessionId: session.id,
    draftChangeCount: overview.draft.changeCount,
    publishChangeCount: overview.publish.changeCount,
    lastTestStatus,
    lastTestAdapter: latestRun?.adapter,
    activeApprovalCount: overview.approvals.active.length,
    availableAdapters: adapters.map((adapter) => adapter.name),
  };

  if (overview.draft.changeCount === 0) {
    const suggestedCalls: HarborSuggestedToolCall[] = [
      {
        tool: "harbor_list_tree",
        arguments: { sessionId: session.id, path: ".", maxDepth: 2 },
        reason: "Explore the repo structure without shell access.",
      },
      {
        tool: "harbor_search_repo",
        arguments: { sessionId: session.id, query: "<symbol or text>", path: "." },
        reason: "Find the exact files to inspect before editing.",
      },
      {
        tool: "harbor_read_file",
        arguments: { sessionId: session.id, path: "README.md" },
        reason: "Read repository files through Harbor's repo-safe view.",
      },
      {
        tool: "harbor_write_draft",
        arguments: { sessionId: session.id, path: "<path>", content: "<updated content>" },
        reason: "Stage changes in the draft overlay instead of mutating the repo directly.",
      },
    ];
    return {
      scope: "session",
      phase: "inspect",
      summary: "This session has no pending draft changes.",
      recommendedNextStep:
        "Inspect the repository, read the relevant files, then write draft changes into the Harbor overlay.",
      whyThisStep:
        "With an empty draft, the main risk is editing the wrong file. Harbor should orient the agent before it stages changes.",
      currentState,
      primaryAction: suggestedCalls[0]!,
      suggestedCalls,
      checklist: [
        "Orient on the repo shape first.",
        "Read the target file before editing it.",
        "Write changes into the draft overlay, not directly into the repository.",
      ],
      approvalFlow: buildApprovalFlow(),
    };
  }

  if (lastTestStatus === "failed") {
    const suggestedCalls: HarborSuggestedToolCall[] = [
      {
        tool: "harbor_diff",
        arguments: { sessionId: session.id },
        reason: "Review the current draft before changing it further.",
      },
      {
        tool: "harbor_list_test_runs",
        arguments: { sessionId: session.id, limit: 5 },
        reason: "Inspect recent Harbor test history for this session.",
      },
      {
        tool: "harbor_write_draft",
        arguments: { sessionId: session.id, path: "<path>", content: "<updated content>" },
        reason: "Revise the draft to fix the failing case.",
      },
    ];
    if (latestRun?.stdoutArtifactId) {
      suggestedCalls.push({
        tool: "harbor_get_artifact",
        arguments: { sessionId: session.id, artifactId: latestRun.stdoutArtifactId, asText: true },
        reason: "Read captured stdout from the latest failing test run.",
      });
    }
    if (latestRun?.stderrArtifactId) {
      suggestedCalls.push({
        tool: "harbor_get_artifact",
        arguments: { sessionId: session.id, artifactId: latestRun.stderrArtifactId, asText: true },
        reason: "Read captured stderr from the latest failing test run.",
      });
    }
    if (adapters.length > 0) {
      suggestedCalls.push({
        tool: "harbor_run_tests",
        arguments: { sessionId: session.id, adapter: adapters[0]!.name },
        reason: "Re-run the most relevant Harbor adapter after revising the draft.",
      });
    }

    return {
      scope: "session",
      phase: "repair",
      summary: "This session has draft changes and the latest Harbor test run failed.",
      recommendedNextStep:
        "Read the failing test artifacts, update the draft, and re-run the relevant Harbor adapter before publish.",
      whyThisStep:
        "A failed validation run means publish is premature; the fastest safe move is to diagnose the failure and repair the draft.",
      currentState,
      primaryAction: suggestedCalls[0]!,
      suggestedCalls,
      checklist: [
        "Inspect the failing diff and recent test run output.",
        "Revise the draft to address the failure.",
        "Re-run the most relevant Harbor adapter before returning to publish.",
      ],
      approvalFlow: buildApprovalFlow(),
    };
  }

  if (lastTestStatus === "passed") {
    const suggestedCalls: HarborSuggestedToolCall[] = [
      {
        tool: "harbor_diff",
        arguments: { sessionId: session.id },
        reason: "Review the exact draft diff before publish.",
      },
      {
        tool: "harbor_publish_preview",
        arguments: { sessionId: session.id },
        reason: "Confirm which paths Harbor will publish from the overlay.",
      },
      {
        tool: "harbor_publish_apply",
        arguments: { sessionId: session.id },
        reason: "Apply the reviewed draft into the repository once the user approves.",
      },
      {
        tool: "harbor_list_approvals",
        arguments: { sessionId: session.id, includeInactive: false },
        reason: "Check whether a publish approval is already active for this session.",
      },
    ];
    return {
      scope: "session",
      phase: "publish",
      summary: "This session has draft changes and the latest Harbor test run passed.",
      recommendedNextStep:
        "Review the diff, preview the publish set, then apply it. If Harbor asks for approval, call `harbor_grant_approval` and retry the publish tool.",
      whyThisStep:
        "Validation has passed, so Harbor should now focus the agent on a controlled review and publish sequence instead of more editing.",
      currentState,
      primaryAction: suggestedCalls[0]!,
      suggestedCalls,
      checklist: [
        "Review the exact diff one more time.",
        "Confirm the publish surface matches intent.",
        "Apply the publish and handle approval if Harbor gates it.",
      ],
      approvalFlow: buildApprovalFlow(),
    };
  }

  const suggestedCalls: HarborSuggestedToolCall[] = [
    {
      tool: "harbor_diff",
      arguments: { sessionId: session.id },
      reason: "Review the current draft before validation.",
    },
    {
      tool: "harbor_list_test_adapters",
      arguments: { sessionId: session.id },
      reason: "See which Harbor-managed test adapters are available.",
    },
  ];
  if (adapters.length > 0) {
    suggestedCalls.push({
      tool: "harbor_run_tests",
      arguments: { sessionId: session.id, adapter: adapters[0]!.name },
      reason: "Validate the draft before moving to publish.",
    });
  }
  suggestedCalls.push({
    tool: "harbor_publish_preview",
    arguments: { sessionId: session.id },
    reason: "Preview the publish set after the draft has been validated.",
  });

  return {
    scope: "session",
    phase: "validate",
    summary: "This session has draft changes but no recorded Harbor test run yet.",
    recommendedNextStep:
      "Validate the draft with a Harbor test adapter, then preview and publish once the user is comfortable with the result.",
    whyThisStep:
      "The draft exists, but Harbor has not yet established whether it is safe to ship. Validation is the next decisive step.",
    currentState,
    primaryAction: suggestedCalls[0]!,
    suggestedCalls,
    checklist: [
      "Inspect the current diff.",
      "Choose a Harbor-managed test adapter.",
      "Run validation before previewing or publishing the draft.",
    ],
    approvalFlow: buildApprovalFlow(),
  };
}

function buildApprovalFlow(): HarborWorkflowGuide["approvalFlow"] {
  return {
    summary: "Harbor approvals are explicit and never auto-retry the blocked action.",
    steps: [
      "If a Harbor tool returns `approval_required`, ask the user for approval.",
      "Call `harbor_grant_approval` with the returned `effectClass`, `targetId`, and scope.",
      "Retry the original Harbor tool after the grant is recorded.",
    ],
  };
}

function shouldHideTreeEntry(parentPath: string, entryPath: string): boolean {
  if (isRepoNoisePath(parentPath)) {
    return false;
  }
  return isRepoNoisePath(entryPath);
}

function isRepoNoisePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized === "." || normalized === "") {
    return false;
  }
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => REPO_NOISE_SEGMENTS.has(segment));
}

function scoreRepoSearchPath(filePath: string, query: string, matchCount: number): number {
  let score = matchCount * 10;
  const normalized = filePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const queryLower = query.toLowerCase();
  const base = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(normalized).toLowerCase();

  if (!isRepoNoisePath(normalized)) {
    score += 100;
  }
  if (lower.startsWith("packages/")) {
    score += 40;
  }
  if (lower.includes("/src/")) {
    score += 50;
  }
  if (base === queryLower || lower.endsWith(`/${queryLower}`)) {
    score += 80;
  }
  if (lower.includes(queryLower)) {
    score += 20;
  }
  if (base === "package.json" || base === "readme.md") {
    score += 15;
  }
  if (SOURCE_FILE_EXTENSIONS.has(ext)) {
    score += 15;
  }
  if (lower.endsWith(".log") || base === "pnpm-lock.yaml" || lower.includes("/dist/")) {
    score -= 60;
  }

  return score;
}

function collectSuggestedSearchScopes(
  files: RepoSearchResult["files"],
  searchPath: string,
): string[] {
  if (searchPath !== ".") {
    return [];
  }

  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    const scope = segments.length > 1 ? segments.slice(0, 2).join("/") : segments[0];
    if (!scope || scope === "." || seen.has(scope)) {
      continue;
    }
    seen.add(scope);
    scopes.push(scope);
    if (scopes.length >= 3) {
      break;
    }
  }
  return scopes;
}

function sliceFileContent(
  filePath: string,
  content: string,
  startLine?: number,
  maxLines?: number,
): FileReadResult {
  if (startLine !== undefined && startLine < 1) {
    throw new ValidationError("startLine must be at least 1", { path: filePath, startLine });
  }
  if (maxLines !== undefined && maxLines < 1) {
    throw new ValidationError("maxLines must be at least 1", { path: filePath, maxLines });
  }

  const lines = splitContentLines(content);
  const totalLines = lines.length;
  if (startLine !== undefined && totalLines > 0 && startLine > totalLines) {
    throw new ValidationError("startLine exceeds file length", {
      path: filePath,
      startLine,
      totalLines,
    });
  }
  const safeStartLine = totalLines === 0 ? 0 : (startLine ?? 1);
  const startIndex = safeStartLine === 0 ? 0 : safeStartLine - 1;
  const endIndex = maxLines === undefined ? totalLines : Math.min(startIndex + maxLines, totalLines);
  const slicedLines = lines.slice(startIndex, endIndex);
  const endLine = slicedLines.length === 0 ? 0 : startIndex + slicedLines.length;

  return {
    path: filePath,
    content: slicedLines.join(""),
    startLine: safeStartLine,
    endLine,
    totalLines,
    returnedLineCount: slicedLines.length,
    truncated: endIndex < totalLines,
    nextStartLine: endIndex < totalLines ? endIndex + 1 : undefined,
  };
}

function splitContentLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
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

function collectPreviewLines(
  file: {
    hunks: Array<{
      lines: string[];
    }>;
  } | undefined,
): string[] {
  if (!file) {
    return [];
  }

  const previewLines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (
        (line.startsWith("+") || line.startsWith("-"))
        && !line.startsWith("+++")
        && !line.startsWith("---")
      ) {
        previewLines.push(line);
      }
      if (previewLines.length >= 4) {
        return previewLines;
      }
    }
  }
  return previewLines;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}
