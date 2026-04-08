import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarborAgentBridge } from "@openharbor/agent-bridge";

async function withTempRepo(
  fn: (paths: { repo: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "openharbor-agent-bridge-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, "node_modules/pkg"), { recursive: true });
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  await writeFile(path.join(repo, "README.md"), "hello world\nhello harbor\n", "utf8");
  await writeFile(path.join(repo, "src/index.ts"), "export const indexValue = 'source';\n", "utf8");
  await writeFile(path.join(repo, "dist/index.js"), "console.log('built');\n", "utf8");
  await writeFile(path.join(repo, "node_modules/pkg/index.js"), "module.exports = 'pkg';\n", "utf8");
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages/mcp-server:\n", "utf8");
  await fn({ repo, dataDir });
}

describe("HarborAgentBridge", () => {
  it("opens sessions, drafts changes, summarizes overview, and publishes with explicit approval", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const bridge = createHarborAgentBridge({ dataDir });
      const globalGuide = await bridge.getWorkflowGuide({});
      expect(globalGuide.status).toBe("ok");
      if (globalGuide.status !== "ok") {
        return;
      }
      expect(globalGuide.data.phase).toBe("start");
      expect(globalGuide.data.primaryAction.tool).toBe("harbor_list_sessions");
      expect(globalGuide.data.suggestedCalls.some((call) => call.tool === "harbor_open_session")).toBe(true);

      const opened = await bridge.openSession({ repoPath: repo, name: "test-session" });
      expect(opened.status).toBe("ok");
      if (opened.status !== "ok") {
        return;
      }

      const sessionId = opened.data.id;
      expect(opened.data.guide.phase).toBe("inspect");
      expect(opened.data.guide.currentState.sessionId).toBe(sessionId);
      expect(opened.data.guide.primaryAction.tool).toBe("harbor_list_tree");
      expect(opened.data.guide.suggestedCalls.some((call) => call.tool === "harbor_list_tree")).toBe(true);
      const adapters = await bridge.listTestAdapters({ sessionId });
      expect(adapters.status).toBe("ok");
      if (adapters.status !== "ok") {
        return;
      }
      expect(adapters.data.adapters.length).toBeGreaterThan(0);

      const emptyGuide = await bridge.getWorkflowGuide({ sessionId });
      expect(emptyGuide.status).toBe("ok");
      if (emptyGuide.status !== "ok") {
        return;
      }
      expect(emptyGuide.data.phase).toBe("inspect");
      expect(emptyGuide.data.currentState.draftChangeCount).toBe(0);

      const startHere = await bridge.startHere({ repoPath: repo });
      expect(startHere.status).toBe("ok");
      if (startHere.status !== "ok") {
        return;
      }
      expect(startHere.data.scope).toBe("session");
      expect(startHere.data.currentState.sessionId).toBe(sessionId);

      const tree = await bridge.listRepoTree({ sessionId, path: ".", maxDepth: 2 });
      expect(tree.status).toBe("ok");
      if (tree.status !== "ok") {
        return;
      }
      expect(tree.data.tree).toContain("src");
      expect(tree.data.tree).not.toContain(".git");
      expect(tree.data.tree).not.toContain("node_modules");
      expect(tree.data.tree).not.toContain("dist");

      const read = await bridge.readRepoFile({ sessionId, path: "hello.txt" });
      expect(read).toMatchObject({
        status: "ok",
        data: {
          path: "hello.txt",
          content: "base\n",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          returnedLineCount: 1,
          truncated: false,
        },
      });

      await writeFile(
        path.join(repo, "long.txt"),
        Array.from({ length: 60 }, (_, index) => `line ${index + 1}\n`).join(""),
        "utf8",
      );
      const chunkedRead = await bridge.readRepoFile({
        sessionId,
        path: "long.txt",
        startLine: 21,
        maxLines: 20,
      });
      expect(chunkedRead).toMatchObject({
        status: "ok",
        data: {
          path: "long.txt",
          startLine: 21,
          endLine: 40,
          totalLines: 60,
          returnedLineCount: 20,
          truncated: true,
          nextStartLine: 41,
        },
      });
      if (chunkedRead.status === "ok") {
        expect(chunkedRead.data.content.startsWith("line 21\n")).toBe(true);
        expect(chunkedRead.data.content.endsWith("line 40\n")).toBe(true);
      }

      const search = await bridge.searchRepo({ sessionId, query: "hello" });
      expect(search.status).toBe("ok");
      if (search.status !== "ok") {
        return;
      }
      expect(search.data.files[0]).toMatchObject({
        path: "README.md",
        matchCount: 2,
        firstMatchLineNumber: 1,
      });
      expect(search.data.suggestedPaths).toContain("README.md");

      const sourceSearch = await bridge.searchRepo({ sessionId, query: "indexValue" });
      expect(sourceSearch.status).toBe("ok");
      if (sourceSearch.status !== "ok") {
        return;
      }
      expect(sourceSearch.data.files[0]?.path).toBe("src/index.ts");
      expect(sourceSearch.data.files.some((file) => file.path.includes("node_modules"))).toBe(false);
      expect(sourceSearch.data.files.some((file) => file.path.includes("dist"))).toBe(false);

      const write = await bridge.writeDraftFile({
        sessionId,
        path: "hello.txt",
        content: "draft\n",
      });
      expect(write).toMatchObject({ status: "ok", data: { ok: true } });

      const overview = await bridge.getSessionOverview({ sessionId });
      expect(overview.status).toBe("ok");
      if (overview.status !== "ok") {
        return;
      }
      expect(overview.data.draft.changeCount).toBe(1);
      expect(overview.data.publish.paths).toContain("hello.txt");

      const preview = await bridge.publishPreview({ sessionId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") {
        return;
      }
      expect(preview.data.paths).toContain("hello.txt");
      expect(preview.data.files).toEqual([
        expect.objectContaining({
          path: "hello.txt",
          addedLines: 1,
          removedLines: 1,
          previewLines: ["-base", "+draft"],
        }),
      ]);
      expect(preview.data.summary).toMatchObject({
        fileCount: 1,
        addedLines: 1,
        removedLines: 1,
      });

      const draftGuide = await bridge.getWorkflowGuide({ sessionId });
      expect(draftGuide.status).toBe("ok");
      if (draftGuide.status !== "ok") {
        return;
      }
      expect(draftGuide.data.phase).toBe("validate");
      expect(draftGuide.data.primaryAction.tool).toBe("harbor_diff");
      expect(draftGuide.data.currentState.draftChangeCount).toBe(1);
      expect(draftGuide.data.currentState.lastTestStatus).toBe("not_run");

      const deniedPublish = await bridge.publishApply({ sessionId });
      expect(deniedPublish.status).toBe("approval_required");
      if (deniedPublish.status !== "approval_required") {
        return;
      }
      expect(deniedPublish.approval.effectClass).toBe("publish.repo");
      expect(deniedPublish.approval.targetId).toBe("repo");

      const granted = await bridge.grantApproval({
        sessionId,
        effectClass: deniedPublish.approval.effectClass,
        targetId: deniedPublish.approval.targetId,
        scope: "once",
      });
      expect(granted).toMatchObject({ status: "ok", data: { granted: true } });

      const published = await bridge.publishApply({ sessionId });
      expect(published.status).toBe("ok");
      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("draft\n");
    });
  });
});
