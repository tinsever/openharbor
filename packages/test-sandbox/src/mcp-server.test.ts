import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StdioClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function withTempRepo(
  fn: (paths: { repo: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "openharbor-mcp-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "hello world\nhello harbor\n", "utf8");
  await fn({ repo, dataDir });
}

describe("Harbor MCP server", () => {
  it("boots over stdio, lists Harbor tools, and runs a session flow", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const cliPath = path.resolve(__dirname, "../../../apps/harbor-cli/dist/cli.js");
      const client = new Client({ name: "openharbor-test-client", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: "node",
        args: [cliPath, "mcp", "serve", "--data-dir", dataDir],
      });

      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toEqual(expect.arrayContaining([
          "harbor_get_guide",
          "harbor_start_here",
          "harbor_open_session",
          "harbor_get_overview",
          "harbor_list_test_adapters",
          "harbor_publish_apply",
        ]));

        const startupGuide = await client.callTool({
          name: "harbor_start_here",
          arguments: {},
        });
        const startupGuideContent = startupGuide.structuredContent as {
          status: string;
          data?: { suggestedCalls: Array<{ tool: string }> };
        };
        expect(startupGuideContent.status).toBe("ok");
        expect(startupGuideContent.data?.suggestedCalls).toEqual(
          expect.arrayContaining([expect.objectContaining({ tool: "harbor_open_session" })]),
        );

        const opened = await client.callTool({
          name: "harbor_open_session",
          arguments: { repoPath: repo, name: "mcp-test" },
        });
        const openedContent = opened.structuredContent as {
          status: string;
          data?: { id: string; guide?: { currentState?: { sessionId?: string }; suggestedCalls?: Array<{ tool: string }> } };
        };
        expect(openedContent.status).toBe("ok");
        const sessionId = openedContent.data?.id;
        expect(typeof sessionId).toBe("string");
        expect(openedContent.data?.guide?.currentState?.sessionId).toBe(sessionId);
        expect(openedContent.data?.guide?.suggestedCalls).toEqual(
          expect.arrayContaining([expect.objectContaining({ tool: "harbor_list_tree" })]),
        );

        const sessionGuide = await client.callTool({
          name: "harbor_get_guide",
          arguments: { sessionId },
        });
        const sessionGuideContent = sessionGuide.structuredContent as {
          status: string;
          data?: { currentState?: { sessionId?: string } };
        };
        expect(sessionGuideContent.status).toBe("ok");
        expect(sessionGuideContent.data?.currentState?.sessionId).toBe(sessionId);

        const read = await client.callTool({
          name: "harbor_read_file",
          arguments: { sessionId, path: "hello.txt" },
        });
        const readContent = read.structuredContent as {
          status: string;
          data?: { content: string };
        };
        expect(readContent).toMatchObject({
          status: "ok",
          data: { content: "base\n" },
        });

        const search = await client.callTool({
          name: "harbor_search_repo",
          arguments: { sessionId, query: "hello" },
        });
        const searchContent = search.structuredContent as {
          status: string;
          data?: { files?: Array<{ path: string; matchCount: number }>; suggestedPaths?: string[] };
        };
        expect(searchContent.status).toBe("ok");
        expect(searchContent.data?.files).toEqual([
          expect.objectContaining({ path: "README.md", matchCount: 2 }),
        ]);
        expect(searchContent.data?.suggestedPaths).toContain("README.md");

        await client.callTool({
          name: "harbor_write_draft",
          arguments: { sessionId, path: "hello.txt", content: "draft\n" },
        });

        const preview = await client.callTool({
          name: "harbor_publish_preview",
          arguments: { sessionId },
        });
        const previewContent = preview.structuredContent as {
          status: string;
          data?: {
            files?: Array<{ path: string; addedLines: number; removedLines: number; previewLines: string[] }>;
            summary?: { fileCount: number; addedLines: number; removedLines: number };
          };
        };
        expect(previewContent.status).toBe("ok");
        expect(previewContent.data?.files).toEqual([
          expect.objectContaining({
            path: "hello.txt",
            addedLines: 1,
            removedLines: 1,
            previewLines: ["-base", "+draft"],
          }),
        ]);
        expect(previewContent.data?.summary).toMatchObject({
          fileCount: 1,
          addedLines: 1,
          removedLines: 1,
        });

        const adapters = await client.callTool({
          name: "harbor_list_test_adapters",
          arguments: { sessionId },
        });
        const adapterContent = adapters.structuredContent as {
          status: string;
          data?: { adapters?: Array<{ name: string }> };
        };
        expect(adapterContent.status).toBe("ok");
        expect(adapterContent.data?.adapters?.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    });
  });
});
