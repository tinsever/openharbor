import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { ApprovalGrant, PiInvokeResult } from "@openharbor/pi-integration";
import { PiHarborBridge } from "@openharbor/pi-integration";

interface HarborRuntimeState {
  bridge: PiHarborBridge;
  sessionId: string;
}

const TOOL_NAMES = [
  "harbor_repo_read_file",
  "harbor_repo_search",
  "harbor_workspace_read_file",
  "harbor_workspace_write_file",
  "harbor_workspace_diff",
  "harbor_tests_run",
  "harbor_publish_preview",
  "harbor_publish_apply",
] as const;

function buildState(pi: ExtensionAPI): HarborRuntimeState {
  const configuredDataDir = getStringFlag(pi, "harbor-data-dir");
  const adaptersCsv = getStringFlag(pi, "harbor-approved-adapters");

  const approvedAdapters = adaptersCsv
    ? adaptersCsv
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

  const bridge = new PiHarborBridge({
    dataDir: configuredDataDir,
    approvedAdapters,
  });

  return {
    bridge,
    sessionId: "",
  };
}

function getStringFlag(pi: ExtensionAPI, key: string): string | undefined {
  const value = pi.getFlag(key);
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function resultToText(result: PiInvokeResult): string {
  if (result.status === "ok") {
    return JSON.stringify(result.value, null, 2);
  }
  if (result.status === "approval_required") {
    return result.intent ?? result.message;
  }
  if (result.status === "validation_error") {
    return `${result.message}\n${JSON.stringify(result.issues, null, 2)}`;
  }
  return result.message;
}

function toolResponse(
  text: string,
  result?: PiInvokeResult,
): { content: Array<{ type: "text"; text: string }>; details: { result: PiInvokeResult | null } } {
  return {
    content: [{ type: "text", text }],
    details: { result: result ?? null },
  };
}

async function invokeWithApproval(
  state: HarborRuntimeState,
  ctx: ExtensionContext,
  request: {
    capability: string;
    input: unknown;
    approvalGrant?: ApprovalGrant;
  },
): Promise<PiInvokeResult> {
  let result = await state.bridge.invoke({
    sessionId: state.sessionId,
    capability: request.capability,
    input: request.input,
  });

  if (result.status !== "approval_required" || !request.approvalGrant) {
    return result;
  }

  if (!ctx.hasUI) {
    return result;
  }

  const approved = await ctx.ui.confirm(
    "Harbor approval required",
    result.intent ?? result.message,
  );
  if (!approved) {
    return result;
  }

  result = await state.bridge.invoke({
    sessionId: state.sessionId,
    capability: request.capability,
    input: request.input,
    approvalGrants: [request.approvalGrant],
  });
  return result;
}

export default function harborPiExtension(pi: ExtensionAPI): void {
  pi.registerFlag("harbor-repo-path", {
    description: "Repository root path for Harbor session creation",
    type: "string",
    default: "",
  });
  pi.registerFlag("harbor-data-dir", {
    description: "OpenHarbor data directory",
    type: "string",
    default: "",
  });
  pi.registerFlag("harbor-approved-adapters", {
    description: "Comma-separated approved Harbor test adapter names",
    type: "string",
    default: "pnpm-test",
  });

  const runtime: { state?: HarborRuntimeState } = {};

  pi.on("session_start", async (_event, ctx) => {
    const state = buildState(pi);
    const configuredRepo = getStringFlag(pi, "harbor-repo-path");
    const repoPath = configuredRepo && configuredRepo.length > 0 ? configuredRepo : ctx.cwd;
    const session = await state.bridge.createSession(repoPath, "pi-harbor");
    state.sessionId = session.id;
    runtime.state = state;

    pi.setActiveTools([...TOOL_NAMES]);
    if (ctx.hasUI) {
      ctx.ui.notify(`Harbor session ready (${session.id.slice(0, 8)})`, "info");
    }
  });

  pi.registerCommand("harbor-session", {
    description: "Show active Harbor session info",
    handler: async (_args, ctx) => {
      const state = runtime.state;
      if (!state) {
        ctx.ui.notify("Harbor session is not initialized yet", "warning");
        return;
      }
      ctx.ui.notify(`Harbor session: ${state.sessionId}`, "info");
    },
  });

  pi.registerTool(
    defineTool({
      name: "harbor_repo_read_file",
      label: "Harbor Repo Read",
      description: "Read a file from the repository through Harbor capability policy.",
      promptSnippet: "Read repository files via Harbor capability host.",
      parameters: Type.Object({
        path: Type.String({ description: "Repository-relative file path" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "repo.readFile",
          input: { path: params.path },
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_repo_search",
      label: "Harbor Repo Search",
      description: "Search repository text through Harbor capability policy.",
      promptSnippet: "Search repository files through Harbor.",
      parameters: Type.Object({
        query: Type.String({ description: "Text query to search for" }),
        path: Type.Optional(Type.String({ description: "Repository-relative directory" })),
        maxResults: Type.Optional(Type.Number({ description: "Max match count", minimum: 1 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "repo.search",
          input: {
            query: params.query,
            path: params.path ?? ".",
            maxResults: params.maxResults ?? 100,
          },
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_workspace_read_file",
      label: "Harbor Workspace Read",
      description: "Read file contents from Harbor overlay (draft-first view).",
      promptSnippet: "Read current draft/workspace files via Harbor overlay.",
      parameters: Type.Object({
        path: Type.String({ description: "Repository-relative file path" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "workspace.readFile",
          input: { path: params.path },
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_workspace_write_file",
      label: "Harbor Workspace Write",
      description: "Write draft file content to Harbor overlay (does not publish to repo).",
      promptSnippet: "Write draft changes in Harbor overlay.",
      parameters: Type.Object({
        path: Type.String({ description: "Repository-relative file path" }),
        content: Type.String({ description: "Full file content to write" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "workspace.writeFile",
          input: { path: params.path, content: params.content },
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_workspace_diff",
      label: "Harbor Workspace Diff",
      description: "Return structured diff for current Harbor overlay against repo base.",
      promptSnippet: "Get a structured diff of all draft changes.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "workspace.diff",
          input: {},
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_tests_run",
      label: "Harbor Tests Run",
      description: "Run approved Harbor test adapters and capture artifacts.",
      promptSnippet: "Run tests via Harbor adapters.",
      parameters: Type.Object({
        adapter: Type.String({ description: "Adapter name, e.g. pnpm-test" }),
        timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds", minimum: 1 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "tests.run",
          input: { adapter: params.adapter, timeoutMs: params.timeoutMs },
          approvalGrant: state.bridge.makeApprovalGrant("execute.adapter", params.adapter),
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_publish_preview",
      label: "Harbor Publish Preview",
      description: "Preview what Harbor would publish from the current overlay.",
      promptSnippet: "Preview publish changes before applying.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "publish.preview",
          input: {},
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "harbor_publish_apply",
      label: "Harbor Publish Apply",
      description: "Apply approved Harbor overlay changes to the repository.",
      promptSnippet: "Publish approved draft changes to repository.",
      parameters: Type.Object({
        resetOverlay: Type.Optional(Type.Boolean({ description: "Reset overlay after publish", default: true })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const state = runtime.state;
        if (!state) {
          return toolResponse("Harbor session not initialized");
        }
        const result = await invokeWithApproval(state, ctx, {
          capability: "publish.apply",
          input: { resetOverlay: params.resetOverlay ?? true },
          approvalGrant: state.bridge.makeApprovalGrant("publish.repo", "repo"),
        });
        return toolResponse(resultToText(result), result);
      },
    }),
  );
}
