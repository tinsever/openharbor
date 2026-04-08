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
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  await fn({ repo, dataDir });
}

describe("HarborAgentBridge", () => {
  it("opens sessions, drafts changes, summarizes overview, and publishes with explicit approval", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const bridge = createHarborAgentBridge({ dataDir });
      const opened = await bridge.openSession({ repoPath: repo, name: "test-session" });
      expect(opened.status).toBe("ok");
      if (opened.status !== "ok") {
        return;
      }

      const sessionId = opened.data.id;
      const read = await bridge.readRepoFile({ sessionId, path: "hello.txt" });
      expect(read).toMatchObject({
        status: "ok",
        data: { content: "base\n" },
      });

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
