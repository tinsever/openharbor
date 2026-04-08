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
          "harbor_open_session",
          "harbor_get_overview",
          "harbor_publish_apply",
        ]));

        const opened = await client.callTool({
          name: "harbor_open_session",
          arguments: { repoPath: repo, name: "mcp-test" },
        });
        const openedContent = opened.structuredContent as {
          status: string;
          data?: { id: string };
        };
        expect(openedContent.status).toBe("ok");
        const sessionId = openedContent.data?.id;
        expect(typeof sessionId).toBe("string");

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
      } finally {
        await client.close();
      }
    });
  });
});
