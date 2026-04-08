import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  createHarborAgentBridge,
  type BridgeResult,
  type HarborAgentBridgeOptions,
  type HarborWorkflowGuide,
  type TestAdapterSummary,
} from "@openharbor/agent-bridge";

interface OpenSessionSummaryLike {
  id: string;
  repoPath: string;
  guide: HarborWorkflowGuide;
}

interface PublishPreviewLike {
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

interface SearchRepoLike {
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

interface FileReadLike {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  returnedLineCount: number;
  truncated: boolean;
  nextStartLine?: number;
}

export interface HarborMcpServerOptions extends HarborAgentBridgeOptions {
  serverName?: string;
  serverVersion?: string;
}

export function createHarborMcpServer(options: HarborMcpServerOptions = {}): McpServer {
  const bridge = createHarborAgentBridge(options);
  const server = new McpServer({
    name: options.serverName ?? "openharbor",
    version: options.serverVersion ?? "0.0.1",
  });

  registerTool(server, "harbor_get_guide", "Start here when you are unsure which Harbor tool to call. Returns the workflow, approval loop, and the next recommended Harbor tool calls for the current repo or session.", z.object({
    repoPath: z.string().optional(),
    sessionId: z.string().optional(),
  }), (input) => bridge.getWorkflowGuide(input));

  registerTool(server, "harbor_start_here", "Start here for the fastest Harbor entrypoint. Returns the next recommended workflow step for the current repo or session.", z.object({
    repoPath: z.string().optional(),
    sessionId: z.string().optional(),
  }), (input) => bridge.startHere(input));

  registerTool(server, "harbor_open_session", "Open an existing Harbor session or create one for a repository.", z.object({
    repoPath: z.string().optional(),
    sessionId: z.string().optional(),
    name: z.string().optional(),
  }), (input) => bridge.openSession(input));

  registerTool(server, "harbor_list_sessions", "List Harbor sessions, optionally scoped to a repository path.", z.object({
    repoPath: z.string().optional(),
  }), (input) => bridge.listSessions(input));

  registerTool(server, "harbor_get_overview", "Get a plain-language Harbor session overview with draft, tests, approvals, and publish summary.", z.object({
    sessionId: z.string(),
  }), (input) => bridge.getSessionOverview(input));

  registerTool(server, "harbor_read_file", "Read a repository file through Harbor's read-only repository capability.", z.object({
    sessionId: z.string(),
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    maxLines: z.number().int().positive().optional(),
  }), (input) => bridge.readRepoFile(input));

  registerTool(server, "harbor_list_tree", "List a repository tree through Harbor's repo view.", z.object({
    sessionId: z.string(),
    path: z.string().optional(),
    maxDepth: z.number().int().nonnegative().optional(),
  }), (input) => bridge.listRepoTree(input));

  registerTool(server, "harbor_search_repo", "Search repository text through Harbor without direct shell access.", z.object({
    sessionId: z.string(),
    query: z.string(),
    path: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  }), (input) => bridge.searchRepo(input));

  registerTool(server, "harbor_read_draft", "Read draft-aware file contents from Harbor overlay state.", z.object({
    sessionId: z.string(),
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    maxLines: z.number().int().positive().optional(),
  }), (input) => bridge.readDraftFile(input));

  registerTool(server, "harbor_write_draft", "Write file content into the Harbor draft overlay without publishing to the repository.", z.object({
    sessionId: z.string(),
    path: z.string(),
    content: z.string(),
  }), (input) => bridge.writeDraftFile(input));

  registerTool(server, "harbor_delete_draft", "Delete a file or directory path in Harbor draft overlay state.", z.object({
    sessionId: z.string(),
    path: z.string(),
    recursive: z.boolean().optional(),
  }), (input) => bridge.deleteDraftPath(input));

  registerTool(server, "harbor_diff", "Inspect the current Harbor draft diff and summary before review or publish.", z.object({
    sessionId: z.string(),
    path: z.string().optional(),
  }), (input) => bridge.diffDraft(input));

  registerTool(server, "harbor_run_tests", "Run a Harbor test adapter within policy and approval controls.", z.object({
    sessionId: z.string(),
    adapter: z.string(),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
    taskId: z.string().optional(),
  }), (input) => bridge.runTests(input));

  registerTool(server, "harbor_list_test_adapters", "List valid Harbor-managed test adapter names before calling `harbor_run_tests`.", z.object({
    sessionId: z.string(),
  }), (input) => bridge.listTestAdapters(input));

  registerTool(server, "harbor_list_test_runs", "List recent Harbor test runs for the session.", z.object({
    sessionId: z.string(),
    limit: z.number().int().positive().max(200).optional(),
  }), (input) => bridge.listTestRuns(input));

  registerTool(server, "harbor_get_artifact", "Read a Harbor session artifact such as test output or captured content.", z.object({
    sessionId: z.string(),
    artifactId: z.string(),
    asText: z.boolean().optional(),
  }), (input) => bridge.getArtifact(input));

  registerTool(server, "harbor_list_approvals", "List Harbor approval grants for the session.", z.object({
    sessionId: z.string(),
    includeInactive: z.boolean().optional(),
  }), (input) => bridge.listApprovals(input));

  registerTool(server, "harbor_grant_approval", "Grant Harbor approval for a specific effect and target. This never retries the original action.", z.object({
    sessionId: z.string(),
    effectClass: z.string(),
    targetId: z.string(),
    scope: z.enum(["once", "task", "session"]),
    taskId: z.string().optional(),
  }), (input) => bridge.grantApproval(input as never));

  registerTool(server, "harbor_revoke_approval", "Revoke Harbor approval grants by id, task, or entire session.", z.object({
    sessionId: z.string(),
    grantId: z.string().optional(),
    taskId: z.string().optional(),
    all: z.boolean().optional(),
    reason: z.string().optional(),
  }), (input) => bridge.revokeApproval(input));

  registerTool(server, "harbor_publish_preview", "Preview what Harbor would publish from the current draft overlay.", z.object({
    sessionId: z.string(),
  }), (input) => bridge.publishPreview(input));

  registerTool(server, "harbor_publish_apply", "Publish Harbor draft changes into the repository after explicit approval.", z.object({
    sessionId: z.string(),
    resetOverlay: z.boolean().optional(),
  }), (input) => bridge.publishApply(input));

  registerTool(server, "harbor_discard_draft", "Discard all or selected Harbor draft paths.", z.object({
    sessionId: z.string(),
    paths: z.array(z.string()).optional(),
  }), (input) => bridge.discardDraft(input));

  registerTool(server, "harbor_revise_review", "Record a Harbor review revision note before publish.", z.object({
    sessionId: z.string(),
    note: z.string(),
  }), (input) => bridge.reviseReview(input));

  registerTool(server, "harbor_reject_publish", "Reject the current Harbor publish intent with a reason.", z.object({
    sessionId: z.string(),
    reason: z.string(),
  }), (input) => bridge.rejectPublish(input));

  return server;
}

export async function runHarborMcpServer(options: HarborMcpServerOptions = {}): Promise<void> {
  const server = createHarborMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function registerTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject<T>,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<BridgeResult<unknown>> | BridgeResult<unknown>,
): void {
  server.registerTool(name, { description, inputSchema }, async (input) => {
    const result = await handler(input as z.infer<z.ZodObject<T>>);
    return {
      content: [{ type: "text", text: formatToolText(name, result) }],
      structuredContent: result,
    };
  });
}

function formatToolText(name: string, result: BridgeResult<unknown>): string {
  if (result.status === "approval_required") {
    return [
      `Tool: ${name}`,
      "Status: approval_required",
      `Message: ${result.message}`,
      result.reason ? `Reason: ${result.reason}` : null,
      `Grant next: harbor_grant_approval ${JSON.stringify({
        sessionId: "<session-id>",
        effectClass: result.approval.effectClass,
        targetId: result.approval.targetId,
        scope: result.approval.scopeHint ?? "once",
        ...(result.approval.taskId ? { taskId: result.approval.taskId } : {}),
      })}`,
      `Then retry: ${name}`,
      result.nextAction ? `Next: ${result.nextAction}` : null,
    ].filter(Boolean).join("\n");
  }

  if (result.status === "ok") {
    const data = result.data as Record<string, unknown>;
    if ((name === "harbor_get_guide" || name === "harbor_start_here") && isWorkflowGuide(data)) {
      return formatWorkflowGuide(data);
    }
    if (name === "harbor_open_session" && isOpenSessionSummary(data)) {
      const lines = [
        `Session ready: ${data.id}`,
        `Repo: ${data.repoPath}`,
        `Summary: ${data.guide.summary}`,
        `Next: ${data.guide.recommendedNextStep}`,
      ];
      if (data.guide.suggestedCalls.length > 0) {
        lines.push("Suggested Harbor calls:");
        for (const call of data.guide.suggestedCalls.slice(0, 3)) {
          lines.push(`- ${call.tool} ${JSON.stringify(call.arguments)}: ${call.reason}`);
        }
      }
      return lines.join("\n");
    }
    if (name === "harbor_get_overview" && isOverviewLike(data)) {
      const session = data.session as Record<string, unknown>;
      const draft = data.draft as Record<string, unknown>;
      const tests = data.tests as Record<string, unknown>;
      const approvals = data.approvals as Record<string, unknown>;
      const publish = data.publish as Record<string, unknown>;
      const draftFiles = Array.isArray(draft.files) ? draft.files as Array<Record<string, unknown>> : [];
      const topDraftFiles = draftFiles.slice(0, 3).map((file) => {
        const path = String(file.path ?? "<path>");
        const added = Number(file.addedLines ?? 0);
        const removed = Number(file.removedLines ?? 0);
        return `${path} (+${added}/-${removed})`;
      });
      return [
        `Session overview for ${String(session.id ?? "<session-id>")}`,
        `Draft changes: ${String(draft.changeCount ?? 0)}`,
        `Recent tests: ${Array.isArray(tests.recentRuns) ? tests.recentRuns.length : 0}`,
        `Active approvals: ${Array.isArray(approvals.active) ? approvals.active.length : 0}`,
        `Publish paths: ${Array.isArray(publish.paths) ? (publish.paths.slice(0, 5).join(", ") || "(none)") : "(none)"}`,
        topDraftFiles.length > 0 ? `Top draft files: ${topDraftFiles.join(", ")}` : null,
        "Next: call `harbor_get_guide` with this session id for the recommended Harbor flow.",
      ].filter(Boolean).join("\n");
    }
    if (name === "harbor_list_sessions" && hasSessionList(data)) {
      const lines = [
        `Harbor sessions: ${data.sessions.length}`,
      ];
      if (data.sessions.length > 0) {
        lines.push("Recent sessions:");
        for (const session of data.sessions.slice(0, 5)) {
          lines.push(`- ${session.id}: ${session.repoPath}`);
        }
        lines.push("Next: resume one with `harbor_open_session {\"sessionId\":\"<session-id>\"}` or ask `harbor_start_here` for guidance.");
      } else {
        lines.push("Next: create one with `harbor_open_session {\"repoPath\":\"/absolute/path/to/repo\"}`.");
      }
      return lines.join("\n");
    }
    if (name === "harbor_list_tree" && isTreeLike(data)) {
      return [
        `Repo tree root: ${data.rootPath}`,
        data.tree,
        "Next: read a file with `harbor_read_file`, or search with `harbor_search_repo` if you know a symbol or string.",
      ].join("\n");
    }
    if ((name === "harbor_read_file" || name === "harbor_read_draft") && isFileReadLike(data)) {
      const displayLimit = 40;
      const visibleEndLine = data.returnedLineCount > 0
        ? Math.min(data.startLine + displayLimit - 1, data.endLine)
        : 0;
      const lines = [
        `${name === "harbor_read_draft" ? "Draft-aware" : "Repository"} file content: ${data.path}`,
        data.returnedLineCount > 0
          ? `Lines: ${data.startLine}-${data.endLine} of ${data.totalLines}${data.truncated ? ` (next starts at line ${data.nextStartLine})` : ""}`
          : `Lines: empty file (${data.totalLines} total)`,
        formatNumberedBlock(data.content, data.startLine, displayLimit),
      ];
      if (data.returnedLineCount > displayLimit) {
        lines.push(`Display clipped to lines ${data.startLine}-${visibleEndLine}; request a smaller window for easier review.`);
      }
      if (data.truncated && data.nextStartLine) {
        lines.push(`Next chunk: \`${
          name === "harbor_read_draft" ? "harbor_read_draft" : "harbor_read_file"
        } ${JSON.stringify({
          sessionId: "<session-id>",
          path: data.path,
          startLine: data.nextStartLine,
          maxLines: Math.max(data.returnedLineCount, 40),
        })}\``);
      } else {
        lines.push("Next: if this is the file you want to change, write a draft and inspect it with `harbor_diff`.");
      }
      return lines.join("\n");
    }
    if (name === "harbor_search_repo" && isSearchRepoLike(data)) {
      const lines = [
        `Search matched ${data.matches.length} line${data.matches.length === 1 ? "" : "s"} across ${data.files.length} file${data.files.length === 1 ? "" : "s"}.`,
        `Scope: ${data.searchPath}`,
        `Scanned files: ${data.scannedFiles}${data.truncated ? " (truncated)" : ""}`,
      ];
      if (data.files.length > 0) {
        lines.push("Top files to inspect:");
        for (const file of data.files.slice(0, 5)) {
          lines.push(`- ${file.path}: ${file.matchCount} match${file.matchCount === 1 ? "" : "es"}, first at line ${file.firstMatchLineNumber}`);
        }
        if (data.truncated && data.recommendedScopes.length > 0) {
          lines.push(`Suggested narrower paths: ${data.recommendedScopes.join(", ")}`);
          lines.push(`Next: retry with \`harbor_search_repo ${JSON.stringify({
            sessionId: "<session-id>",
            query: data.query,
            path: data.recommendedScopes[0],
          })}\`.`);
        } else {
          lines.push(`Next: read ${data.suggestedPaths[0] ?? "<path>"} with \`harbor_read_file\`.`);
        }
      } else {
        lines.push("Next: broaden the query or search a narrower path.");
      }
      return lines.join("\n");
    }
    if (name === "harbor_write_draft" && isWriteDraftResult(data)) {
      return [
        "Draft updated in Harbor overlay.",
        "Next: inspect the staged change with `harbor_diff`, or preview publish with `harbor_publish_preview` once you’re ready.",
      ].join("\n");
    }
    if (name === "harbor_diff" && isDiffLike(data)) {
      const lines = [
        `Draft diff: ${data.summary.fileCount} file${data.summary.fileCount === 1 ? "" : "s"}, +${data.summary.addedLines} / -${data.summary.removedLines}`,
      ];
      if (data.files.length > 0) {
        lines.push("Changed files:");
        for (const file of data.files.slice(0, 5)) {
          lines.push(`- ${file.path}: ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`);
        }
      }
      lines.push("Next: run Harbor tests or inspect the publish surface with `harbor_publish_preview`.");
      return lines.join("\n");
    }
    if (name === "harbor_list_test_adapters" && hasAdapters(data)) {
      return [
        "Available Harbor test adapters:",
        ...data.adapters.map((adapter) => `- ${adapter.name}: ${adapter.description}`),
        "Next: call `harbor_run_tests` with one of these adapter names.",
      ].join("\n");
    }
    if (name === "harbor_run_tests" && isTestRunResult(data)) {
      return [
        `Test adapter: ${data.adapter}`,
        `Result: ${data.ok ? "passed" : "failed"}`,
        `Exit code: ${data.exitCode}`,
        data.stdoutArtifactId ? `stdout artifact: ${data.stdoutArtifactId}` : null,
        data.stderrArtifactId ? `stderr artifact: ${data.stderrArtifactId}` : null,
        data.ok
          ? "Next: review the diff or preview publish."
          : "Next: inspect the artifacts, revise the draft, and rerun Harbor tests.",
      ].filter(Boolean).join("\n");
    }
    if (name === "harbor_publish_preview" && isPublishPreview(data)) {
      const lines = [
        `Publish preview: ${data.changeCount} changed path${data.changeCount === 1 ? "" : "s"}`,
        `Summary: ${data.summary.addedLines} added, ${data.summary.removedLines} removed across ${data.summary.fileCount} file${data.summary.fileCount === 1 ? "" : "s"}`,
        `Paths: ${data.paths.join(", ") || "(none)"}`,
      ];
      if (data.files.length > 0) {
        lines.push("Files:");
        for (const file of data.files.slice(0, 5)) {
          lines.push(`- ${file.path}: +${file.addedLines} -${file.removedLines} across ${file.hunkCount} hunk${file.hunkCount === 1 ? "" : "s"}`);
          if (file.previewLines.length > 0) {
            for (const previewLine of file.previewLines.slice(0, 4)) {
              lines.push(`  ${previewLine}`);
            }
          }
        }
      }
      lines.push("Next: if you need the full patch, call `harbor_diff`; if this looks right, call `harbor_publish_apply` and handle approval if Harbor requests it.");
      return lines.join("\n");
    }
    if (name === "harbor_publish_apply" && isPublishLike(data)) {
      return [
        `Published ${data.changeCount} path${data.changeCount === 1 ? "" : "s"} into the repository.`,
        `Paths: ${data.paths.join(", ") || "(none)"}`,
      ].join("\n");
    }
    if (name === "harbor_discard_draft" && isDiscardLike(data)) {
      return [
        "Draft discarded from Harbor overlay.",
        "Next: ask `harbor_get_overview` or `harbor_start_here` to confirm the session is clean and see the next recommended step.",
      ].join("\n");
    }

    return JSON.stringify({
      tool: name,
      status: result.status,
      data: result.data,
    }, null, 2);
  }
  if (result.status === "denied") {
    return [
      `Tool: ${name}`,
      "Status: denied",
      `Message: ${result.message}`,
      result.reason ? `Reason: ${result.reason}` : null,
      result.nextAction ? `Next: ${result.nextAction}` : null,
    ].filter(Boolean).join("\n");
  }
  if (result.status === "validation_error") {
    return [
      `Tool: ${name}`,
      "Status: validation_error",
      `Message: ${result.message}`,
      result.nextAction ? `Next: ${result.nextAction}` : null,
      `Issues: ${JSON.stringify(result.issues)}`,
    ].join("\n");
  }
  if (result.status === "not_found") {
    return [
      `Tool: ${name}`,
      "Status: not_found",
      `Message: ${result.message}`,
      `Missing: ${result.entity}`,
    ].join("\n");
  }
  return JSON.stringify({ tool: name }, null, 2);
}

function formatWorkflowGuide(guide: HarborWorkflowGuide): string {
  const lines = [
    `Harbor guide scope: ${guide.scope}`,
    `Phase: ${guide.phase}`,
    `Summary: ${guide.summary}`,
    `Next: ${guide.recommendedNextStep}`,
    `Why now: ${guide.whyThisStep}`,
  ];

  if (guide.currentState.sessionId) {
    lines.push(`Session: ${guide.currentState.sessionId}`);
  }
  if (guide.currentState.repoPath) {
    lines.push(`Repo: ${guide.currentState.repoPath}`);
  }
  if (typeof guide.currentState.draftChangeCount === "number") {
    lines.push(`Draft changes: ${guide.currentState.draftChangeCount}`);
  }
  if (typeof guide.currentState.publishChangeCount === "number") {
    lines.push(`Publish changes: ${guide.currentState.publishChangeCount}`);
  }
  if (guide.currentState.lastTestStatus) {
    lines.push(`Last test status: ${guide.currentState.lastTestStatus}`);
  }
  if (guide.currentState.availableAdapters && guide.currentState.availableAdapters.length > 0) {
    lines.push(`Available adapters: ${guide.currentState.availableAdapters.join(", ")}`);
  }

  lines.push(`Do this now: ${guide.primaryAction.tool} ${JSON.stringify(guide.primaryAction.arguments)}`);
  lines.push(`Primary reason: ${guide.primaryAction.reason}`);

  if (guide.checklist.length > 0) {
    lines.push("Checklist:");
    for (const item of guide.checklist) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("Suggested Harbor calls:");
  for (const call of guide.suggestedCalls) {
    lines.push(`- ${call.tool} ${JSON.stringify(call.arguments)}: ${call.reason}`);
  }

  lines.push(`Approval flow: ${guide.approvalFlow.summary}`);
  for (const step of guide.approvalFlow.steps) {
    lines.push(`- ${step}`);
  }

  return lines.join("\n");
}

function isWorkflowGuide(value: unknown): value is HarborWorkflowGuide {
  return isRecord(value)
    && typeof value.scope === "string"
    && typeof value.phase === "string"
    && typeof value.summary === "string"
    && typeof value.recommendedNextStep === "string"
    && typeof value.whyThisStep === "string"
    && isRecord(value.primaryAction)
    && Array.isArray(value.suggestedCalls)
    && Array.isArray(value.checklist);
}

function isOpenSessionSummary(value: unknown): value is OpenSessionSummaryLike {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.repoPath === "string"
    && isWorkflowGuide(value.guide);
}

function isOverviewLike(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isRecord(value.session)
    && isRecord(value.draft)
    && isRecord(value.tests)
    && isRecord(value.approvals)
    && isRecord(value.publish);
}

function hasSessionList(value: unknown): value is {
  sessions: Array<{ id: string; repoPath: string }>;
} {
  return isRecord(value) && Array.isArray(value.sessions);
}

function isTreeLike(value: unknown): value is { rootPath: string; tree: string } {
  return isRecord(value)
    && typeof value.rootPath === "string"
    && typeof value.tree === "string";
}

function isFileReadLike(value: unknown): value is FileReadLike {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.content === "string"
    && typeof value.startLine === "number"
    && typeof value.endLine === "number"
    && typeof value.totalLines === "number"
    && typeof value.returnedLineCount === "number"
    && typeof value.truncated === "boolean";
}

function isSearchRepoLike(value: unknown): value is SearchRepoLike {
  return isRecord(value)
    && typeof value.query === "string"
    && typeof value.searchPath === "string"
    && Array.isArray(value.matches)
    && typeof value.scannedFiles === "number"
    && typeof value.truncated === "boolean"
    && Array.isArray(value.files)
    && Array.isArray(value.suggestedPaths)
    && Array.isArray(value.recommendedScopes);
}

function isWriteDraftResult(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

function isDiffLike(value: unknown): value is {
  files: Array<{ path: string; hunks: unknown[] }>;
  summary: { fileCount: number; addedLines: number; removedLines: number };
} {
  return isRecord(value)
    && Array.isArray(value.files)
    && isRecord(value.summary)
    && typeof value.summary.fileCount === "number"
    && typeof value.summary.addedLines === "number"
    && typeof value.summary.removedLines === "number";
}

function hasAdapters(value: unknown): value is { adapters: TestAdapterSummary[] } {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.adapters);
}

function isTestRunResult(value: unknown): value is {
  adapter: string;
  ok: boolean;
  exitCode: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
} {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.adapter === "string"
    && typeof value.ok === "boolean"
    && typeof value.exitCode === "number";
}

function isPublishLike(value: unknown): value is { changeCount: number; paths: string[] } {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.changeCount === "number" && Array.isArray(value.paths);
}

function isPublishPreview(value: unknown): value is PublishPreviewLike {
  if (!isPublishLike(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return isRecord(candidate.summary) && Array.isArray(candidate.files);
}

function isDiscardLike(value: unknown): value is { discarded: true } {
  return isRecord(value) && value.discarded === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatNumberedBlock(content: string, startLine: number, maxLines: number): string {
  const rawLines = splitContentLines(content);
  if (rawLines.length === 0) {
    return "(empty)";
  }

  const numbered = rawLines.slice(0, maxLines).map((line, index) => {
    const lineNumber = startLine + index;
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    return `${String(lineNumber).padStart(5, " ")} | ${text}`;
  });

  if (rawLines.length > maxLines) {
    numbered.push("...");
  }

  return numbered.join("\n");
}

function splitContentLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
