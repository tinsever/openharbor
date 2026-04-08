import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runExecFile = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function withTempRepo(
  fn: (paths: { repo: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "openharbor-cli-pack-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  await fn({ repo, dataDir });
}

async function runHarborCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const cliPath = path.resolve(__dirname, "../../../apps/harbor-cli/dist/cli.js");
  const out = await runExecFile("node", [cliPath, ...args], {
    cwd,
    env: process.env,
  });
  return {
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

describe("CLI capability-pack surface", () => {
  it("lists prototype pack capabilities in harbor caps output", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const out = await runHarborCli(["caps", "--data-dir", dataDir], repo);
      const parsed = JSON.parse(out.stdout) as { capabilities: string[] };
      expect(parsed.capabilities).toEqual(
        expect.arrayContaining([
          "http.fetch",
          "docs.ingestArtifact",
          "docs.query",
          "browser.observeHtml",
        ]),
      );
    });
  });
});
