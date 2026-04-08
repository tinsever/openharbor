import { McpServer, StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  createHarborAgentBridge,
  type BridgeResult,
  type HarborAgentBridgeOptions,
} from "@openharbor/agent-bridge";

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
  if (result.status === "ok") {
    return JSON.stringify({
      tool: name,
      status: result.status,
      data: result.data,
    }, null, 2);
  }
  return JSON.stringify({ tool: name, ...result }, null, 2);
}
