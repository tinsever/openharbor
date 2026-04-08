import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ApprovalRequiredError, ValidationError } from "@openharbor/core";
import { createHarborEnvironment } from "@openharbor/host";
import { createHarborInvokeBridge } from "./harbor-bridge.js";
import { evalInTestSandbox } from "./vm-sandbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adversarialFixtureDir = path.resolve(__dirname, "../fixtures/adversarial-repo");
const runExecFile = promisify(execFile);

async function withTempRepo(
  fn: (paths: { repo: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "openharbor-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  try {
    await fn({ repo, dataDir });
  } finally {
    // temp dir left for inspection on failure; could rmSync in CI
  }
}

async function seedAdversarialFixture(repo: string): Promise<void> {
  await cp(adversarialFixtureDir, repo, { recursive: true, force: true });
}

async function runHarborCli(
  args: string[],
  cwd: string,
  opts?: {
    expectFailure?: boolean;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.resolve(__dirname, "../../../apps/harbor-cli/dist/cli.js");
  let out: Awaited<ReturnType<typeof runExecFile>>;
  try {
    out = await runExecFile("node", [cliPath, ...args], {
      cwd,
      env: process.env,
    });
  } catch (error) {
    if (!opts?.expectFailure) {
      throw error;
    }
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
      message: string;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
  return {
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: 0,
  };
}

function parseLastJsonObject(stdout: string): Record<string, unknown> {
  const candidates: number[] = [];
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout[i] === "{") {
      candidates.push(i);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const marker = candidates[i]!;
    const jsonText = stdout.slice(marker);
    try {
      return JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      // keep scanning for a valid trailing JSON object
    }
  }
  throw new Error(`No JSON object found in stdout: ${stdout}`);
}

function normalizeDynamic(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>")
    .replace(/run-[a-z0-9-]+/gi, "<run-id>")
    .replace(/\b[0-9a-f]{8}\b/gi, "<short-id>");
}

function hashLegacyAuditRecord(input: {
  id: string;
  ts: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}): string {
  const canonical = stableStringify(input);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

describe("Harbor integration", () => {
  it("reads repo files and writes overlay drafts", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const read = await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      expect(read).toEqual({ content: "base\n" });

      await env.invoke(session.id, "workspace.writeFile", {
        path: "draft.txt",
        content: "draft",
      });

      const preview = await env.invoke(session.id, "publish.preview", {});
      expect(preview).toMatchObject({ changeCount: 1, paths: ["draft.txt"] });

      const bundle = await env.sessions.getBundle(session.id);
      const persisted = await bundle.overlay.toPersisted();
      expect(persisted.changes.length).toBeGreaterThan(0);
    });
  });

  it("lists directories, stats paths, and searches repo text", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "app.ts"), "const value = 42;\n", "utf8");
      await writeFile(path.join(repo, "notes.md"), "Harbor search target\n", "utf8");

      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const listRoot = (await env.invoke(session.id, "repo.listDir", { path: "." })) as {
        entries: Array<{ path: string; type: string }>;
      };
      expect(listRoot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "hello.txt", type: "file" }),
          expect.objectContaining({ path: "src", type: "dir" }),
        ]),
      );

      const statFound = (await env.invoke(session.id, "repo.stat", {
        path: "src/app.ts",
      })) as {
        exists: boolean;
        type?: string;
      };
      expect(statFound).toMatchObject({ exists: true, type: "file" });

      const statMissing = (await env.invoke(session.id, "repo.stat", {
        path: "missing.ts",
      })) as { exists: boolean };
      expect(statMissing).toEqual({ exists: false });

      const search = (await env.invoke(session.id, "repo.search", {
        query: "harbor",
        caseSensitive: false,
      })) as {
        matches: Array<{ path: string; lineNumber: number; line: string }>;
        truncated: boolean;
      };
      expect(search.truncated).toBe(false);
      expect(search.matches).toContainEqual({
        path: "notes.md",
        lineNumber: 1,
        line: "Harbor search target",
      });
    });
  });

  it("supports overlay read/delete/list/reset capabilities", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "workspace.writeFile", {
        path: "draft.txt",
        content: "draft-v1",
      });
      const readDraft = await env.invoke(session.id, "workspace.readFile", {
        path: "draft.txt",
      });
      expect(readDraft).toEqual({ content: "draft-v1" });

      await env.invoke(session.id, "workspace.deleteFile", { path: "hello.txt" });
      const changes = (await env.invoke(session.id, "workspace.listChanges", {})) as {
        changes: Array<{ path: string; kind: string }>;
      };
      expect(changes.changes).toEqual(
        expect.arrayContaining([
          { path: "draft.txt", kind: "create" },
          { path: "hello.txt", kind: "delete" },
        ]),
      );

      await env.invoke(session.id, "workspace.reset", { paths: ["draft.txt"] });
      const afterPartialReset = (await env.invoke(session.id, "workspace.listChanges", {})) as {
        changes: Array<{ path: string; kind: string }>;
      };
      expect(afterPartialReset.changes).toEqual([{ path: "hello.txt", kind: "delete" }]);

      await env.invoke(session.id, "workspace.reset", {});
      const afterFullReset = (await env.invoke(session.id, "workspace.listChanges", {})) as {
        changes: Array<{ path: string; kind: string }>;
      };
      expect(afterFullReset.changes).toEqual([]);
    });
  });

  it("deletes directory paths in overlay and removes them on publish", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      await mkdir(path.join(repo, "packages", "runtime"), { recursive: true });
      await writeFile(path.join(repo, "packages", "runtime", "index.ts"), "export const x = 1;\n", "utf8");
      await writeFile(path.join(repo, "packages", "root.txt"), "root\n", "utf8");

      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const deleted = (await env.invoke(session.id, "workspace.deletePath", {
        path: "packages",
      })) as { ok: boolean; deleted: number };
      expect(deleted.ok).toBe(true);
      expect(deleted.deleted).toBeGreaterThan(0);

      const preview = (await env.invoke(session.id, "publish.preview", {})) as {
        changeCount: number;
        paths: string[];
      };
      expect(preview.paths).toEqual(expect.arrayContaining(["packages/root.txt", "packages/runtime/index.ts"]));

      await env.invoke(
        session.id,
        "publish.apply",
        {},
        { approvalGrants: [{ scope: "once", effectClass: "publish.repo", targetId: "repo" }] },
      );

      await expect(access(path.join(repo, "packages"))).rejects.toThrow();
    });
  });

  it("applies structured workspace patches", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const out = (await env.invoke(session.id, "workspace.applyPatch", {
        changes: [
          { path: "hello.txt", content: "patched\n" },
          { path: "new.txt", content: "created\n" },
        ],
      })) as { applied: number };
      expect(out.applied).toBe(2);

      const hello = await env.invoke(session.id, "workspace.readFile", { path: "hello.txt" });
      const created = await env.invoke(session.id, "workspace.readFile", { path: "new.txt" });
      expect(hello).toEqual({ content: "patched\n" });
      expect(created).toEqual({ content: "created\n" });
    });
  });

  it("stores and retrieves artifacts", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const put = (await env.invoke(session.id, "artifacts.put", {
        content: "artifact-body",
        mimeType: "text/plain",
      })) as { artifactId: string; sizeBytes: number };
      expect(put.sizeBytes).toBeGreaterThan(0);

      const list = (await env.invoke(session.id, "artifacts.list", {})) as {
        artifacts: Array<{ artifactId: string }>;
      };
      expect(list.artifacts.some((a) => a.artifactId === put.artifactId)).toBe(true);

      const get = (await env.invoke(session.id, "artifacts.get", {
        artifactId: put.artifactId,
      })) as { found: boolean; content?: string };
      expect(get).toEqual({ found: true, content: "artifact-body", artifactId: put.artifactId, mimeType: "text/plain", sizeBytes: 13 });
    });
  });

  it("runs tests through approved adapter and fetches result", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const adapters = (await env.invoke(session.id, "tests.listAdapters", {})) as {
        adapters: Array<{ name: string }>;
      };
      expect(adapters.adapters.length).toBeGreaterThan(0);

      await expect(
        env.invoke(
          session.id,
          "tests.run",
          { adapter: "pnpm-test", args: ["--version"] },
        ),
      ).rejects.toThrow(ApprovalRequiredError);

      const run = (await env.invoke(
        session.id,
        "tests.run",
        { adapter: "pnpm-test", args: ["--version"] },
        { approvedAdapters: new Set(["pnpm-test"]) },
      )) as {
        runId: string;
        ok: boolean;
      };
      expect(run.ok).toBe(true);

      const result = (await env.invoke(session.id, "tests.getResult", {
        runId: run.runId,
      })) as {
        found: boolean;
        run?: { runId: string; adapter: string };
      };
      expect(result.found).toBe(true);
      expect(result.run).toMatchObject({ runId: run.runId, adapter: "pnpm-test" });

      const listed = (await env.invoke(session.id, "tests.listRuns", { limit: 10 })) as {
        runs: Array<{ runId: string; adapter: string }>;
      };
      expect(listed.runs.some((item) => item.runId === run.runId)).toBe(true);
    });
  });

  it("supports permissive, balanced, and strict policy presets for test execution", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const permissiveEnv = createHarborEnvironment({
        dataDir: path.join(dataDir, "permissive"),
        policyPreset: "permissive",
      });
      const permissiveSession = await permissiveEnv.sessions.createSession(repo);
      const permissiveRun = (await permissiveEnv.invoke(
        permissiveSession.id,
        "tests.run",
        { adapter: "pnpm-test", args: ["--version"] },
      )) as { ok: boolean };
      expect(permissiveRun.ok).toBe(true);

      const balancedEnv = createHarborEnvironment({
        dataDir: path.join(dataDir, "balanced"),
        policyPreset: "balanced",
      });
      const balancedSession = await balancedEnv.sessions.createSession(repo);
      await expect(
        balancedEnv.invoke(
          balancedSession.id,
          "tests.run",
          { adapter: "pnpm-test", args: ["--version"] },
        ),
      ).rejects.toThrow(ApprovalRequiredError);

      const balancedApprovedRun = (await balancedEnv.invoke(
        balancedSession.id,
        "tests.run",
        { adapter: "pnpm-test", args: ["--version"] },
        { approvedAdapters: new Set(["pnpm-test"]) },
      )) as { ok: boolean };
      expect(balancedApprovedRun.ok).toBe(true);

      const strictEnv = createHarborEnvironment({
        dataDir: path.join(dataDir, "strict"),
        policyPreset: "strict",
      });
      const strictSession = await strictEnv.sessions.createSession(repo);
      await expect(
        strictEnv.invoke(
          strictSession.id,
          "tests.run",
          { adapter: "pnpm-test", args: ["--version"] },
          { approvedAdapters: new Set(["pnpm-test"]) },
        ),
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  it("publishes overlay changes to repo only when granted approval", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "published\n",
      });
      await env.invoke(session.id, "workspace.writeFile", {
        path: "new.txt",
        content: "new file\n",
      });

      await expect(env.invoke(session.id, "publish.apply", {})).rejects.toThrow(
        ApprovalRequiredError,
      );

      const publish = (await env.invoke(
        session.id,
        "publish.apply",
        {},
        {
          approvalGrants: [{ scope: "once", effectClass: "publish.repo", targetId: "repo" }],
        },
      )) as { published: boolean; changeCount: number };
      expect(publish).toMatchObject({ published: true, changeCount: 2 });

      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("published\n");
      expect(await readFile(path.join(repo, "new.txt"), "utf8")).toBe("new file\n");

      const changesAfter = (await env.invoke(session.id, "workspace.listChanges", {})) as {
        changes: unknown[];
      };
      expect(changesAfter.changes).toEqual([]);

      await expect(env.invoke(session.id, "publish.apply", {})).rejects.toThrow(
        ApprovalRequiredError,
      );
    });
  });

  it("executes model-authored code via runtime bridge without shell access", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const run = await env.runModelTask(
        session.id,
        [
          'const initial = await harbor.invoke("repo.readFile", { path: "hello.txt" });',
          'await harbor.invoke("workspace.writeFile", { path: "hello.txt", content: initial.content.toUpperCase() });',
          'return await harbor.invoke("publish.preview", {});',
        ].join("\n"),
        { taskId: "task-model-run" },
      );

      expect(run.ok).toBe(true);
      expect(run.value).toMatchObject({ changeCount: 1, paths: ["hello.txt"] });

      const changed = await env.invoke(session.id, "workspace.readFile", { path: "hello.txt" });
      expect(changed).toEqual({ content: "BASE\n" });
    });
  });

  it("truncates oversized model runtime output and records artifact", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const run = await env.runModelTask(
        session.id,
        [
          "for (let i = 0; i < 200; i += 1) {",
          "  console.log('line-' + String(i).padStart(4, '0') + ':' + 'x'.repeat(64));",
          "}",
          "return true;",
        ].join("\n"),
        {
          limits: {
            maxOutputBytes: 256,
          },
        },
      );

      expect(run.ok).toBe(true);
      expect(run.truncatedOutput).toBe(true);
      expect(run.stdoutArtifactId).toBeTruthy();
      const stdout = (await env.invoke(session.id, "artifacts.get", {
        artifactId: run.stdoutArtifactId,
      })) as { found: boolean; content?: string };
      expect(stdout.found).toBe(true);
      expect((stdout.content ?? "").length).toBeGreaterThan(0);
      expect(Buffer.byteLength(stdout.content ?? "", "utf8")).toBeLessThanOrEqual(256);
    });
  });

  it("supports task and session scoped approval grants", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "task-granted\n",
      });

      const taskId = "task-123";
      await expect(
        env.invoke(session.id, "publish.apply", {}, { taskId }),
      ).rejects.toThrow(ApprovalRequiredError);

      await env.invoke(
        session.id,
        "publish.apply",
        {},
        {
          taskId,
          approvalGrants: [{ scope: "task", effectClass: "publish.repo", targetId: "repo" }],
        },
      );

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "task-reused\n",
      });
      await expect(
        env.invoke(session.id, "publish.apply", {}, { taskId: "other-task" }),
      ).rejects.toThrow(ApprovalRequiredError);
      await env.invoke(session.id, "publish.apply", {}, { taskId });

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "session-granted\n",
      });
      await env.invoke(
        session.id,
        "publish.apply",
        {},
        {
          approvalGrants: [{ scope: "session", effectClass: "publish.repo", targetId: "repo" }],
        },
      );

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "session-reused\n",
      });
      await env.invoke(session.id, "publish.apply", {});
      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("session-reused\n");
    });
  });

  it("persists session and task grants across host restarts", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const envA = createHarborEnvironment(dataDir);
      const session = await envA.sessions.createSession(repo);

      await envA.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "session-1\n",
      });
      await envA.invoke(
        session.id,
        "publish.apply",
        {},
        {
          approvalGrants: [{ scope: "session", effectClass: "publish.repo", targetId: "repo" }],
        },
      );

      const envB = createHarborEnvironment(dataDir);
      await envB.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "session-2\n",
      });
      await envB.invoke(session.id, "publish.apply", {});

      await envB.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "task-1\n",
      });
      await envB.invoke(session.id, "approvals.revoke", { all: true });
      await envB.invoke(
        session.id,
        "publish.apply",
        {},
        {
          taskId: "persisted-task",
          approvalGrants: [{ scope: "task", effectClass: "publish.repo", targetId: "repo" }],
        },
      );

      const envC = createHarborEnvironment(dataDir);
      await envC.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "task-2\n",
      });
      await envC.invoke(session.id, "publish.apply", {}, { taskId: "persisted-task" });
      await expect(
        envC.invoke(session.id, "publish.apply", {}, { taskId: "different-task" }),
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  it("lists and revokes grants through capabilities", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(
        session.id,
        "publish.apply",
        {},
        {
          taskId: "task-1",
          approvalGrants: [
            { scope: "session", effectClass: "publish.repo", targetId: "repo" },
            { scope: "task", effectClass: "publish.repo", targetId: "repo" },
          ],
        },
      );

      const listed = (await env.invoke(session.id, "approvals.list", {})) as {
        grants: Array<{ id: string; scope: string; status: string; taskId?: string }>;
      };
      const sessionGrant = listed.grants.find((g) => g.scope === "session");
      const taskGrant = listed.grants.find((g) => g.scope === "task" && g.taskId === "task-1");
      expect(sessionGrant).toBeTruthy();
      expect(taskGrant).toBeTruthy();

      const revokeTask = (await env.invoke(session.id, "approvals.revoke", {
        taskId: "task-1",
        reason: "task done",
      })) as { revokedCount: number };
      expect(revokeTask.revokedCount).toBeGreaterThanOrEqual(1);

      const revokeOne = (await env.invoke(session.id, "approvals.revoke", {
        grantId: sessionGrant!.id,
      })) as { revokedCount: number };
      expect(revokeOne.revokedCount).toBe(1);

      const after = (await env.invoke(session.id, "approvals.list", {
        includeInactive: false,
      })) as { grants: Array<{ id: string }> };
      expect(after.grants).toEqual([]);
    });
  });

  it("requires taskId for task-scoped approval grants", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "needs-task-id\n",
      });
      await expect(
        env.invoke(session.id, "publish.apply", {}, {
          approvalGrants: [{ scope: "task", effectClass: "publish.repo", targetId: "repo" }],
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it("rejects malformed capability input via schema validation", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await expect(
        env.invoke(session.id, "workspace.writeFile", { path: "x.txt" }),
      ).rejects.toThrow(ValidationError);

      await expect(
        env.invoke(session.id, "repo.search", { query: "", maxResults: 2_000 }),
      ).rejects.toThrow(ValidationError);
    });
  });

  it("rejects unknown adapter even when adapter effect is approved", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await expect(
        env.invoke(
          session.id,
          "tests.run",
          { adapter: "totally-unknown" },
          { approvedAdapters: new Set(["totally-unknown"]) },
        ),
      ).rejects.toThrow("Unknown test adapter");
    });
  });

  it("runs test adapters with best-effort network restrictions", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const run = (await env.invoke(
        session.id,
        "tests.run",
        {
          adapter: "pnpm-test",
          args: [
            "exec",
            "node",
            "-e",
            "try { require('node:http').get('http://example.com',()=>{}); process.exit(0); } catch (e) { console.error(String(e && e.message ? e.message : e)); process.exit(13); }",
          ],
        },
        { approvedAdapters: new Set(["pnpm-test"]) },
      )) as { ok: boolean; exitCode: number; timedOut: boolean; stderrArtifactId?: string };

      expect(run.ok).toBe(false);
      expect(run.exitCode).not.toBe(0);
      expect(run.timedOut).toBe(false);
      if (run.stderrArtifactId) {
        const stderr = (await env.invoke(session.id, "artifacts.get", {
          artifactId: run.stderrArtifactId,
        })) as { found: boolean; content?: string };
        expect(stderr.found).toBe(true);
        expect(stderr.content ?? "").toContain("Network access is disabled by OpenHarbor test adapter");
      }
    });
  });

  it("consumes once-scoped publish grant and prevents bypass", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "first\n",
      });

      await env.invoke(
        session.id,
        "publish.apply",
        {},
        { approvalGrants: [{ scope: "once", effectClass: "publish.repo", targetId: "repo" }] },
      );

      await env.invoke(session.id, "workspace.writeFile", {
        path: "hello.txt",
        content: "second\n",
      });
      await expect(env.invoke(session.id, "publish.apply", {})).rejects.toThrow(
        ApprovalRequiredError,
      );
    });
  });

  it("enforces repo search limits", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      await writeFile(path.join(repo, "multi.txt"), "hit one\nhit two\n", "utf8");

      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const search = (await env.invoke(session.id, "repo.search", {
        query: "hit",
        maxResults: 1,
      })) as {
        matches: Array<{ path: string }>;
        truncated: boolean;
      };

      expect(search.matches).toHaveLength(1);
      expect(search.truncated).toBe(true);
    });
  });

  it("blocks publish.request until approval flow exists", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      await expect(env.invoke(session.id, "publish.request", {})).rejects.toThrow(
        ApprovalRequiredError,
      );
    });
  });

  it("records audit entries for capability calls", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      const events = await env.store.readAudit(session.id);
      const types = events.map((e) => e.type);
      expect(types).toContain("session.created");
      expect(types.filter((t) => t === "capability.call").length).toBeGreaterThan(0);
      expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
    });
  });

  it("reads legacy unversioned audit events and normalizes schemaVersion", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      const auditPath = path.join(dataDir, "sessions", session.id, "audit.jsonl");
      const text = await readFile(auditPath, "utf8");
      const firstLine = text.split("\n").find(Boolean);
      expect(firstLine).toBeTruthy();

      const parsed = JSON.parse(firstLine!) as Record<string, unknown>;
      const { schemaVersion: _dropSchemaVersion, ...legacyLine } = parsed;
      const legacyPayload = (legacyLine.payload ?? {}) as Record<string, unknown>;
      const { __integrity: _dropIntegrity, ...legacyPayloadWithoutIntegrity } = legacyPayload;
      const legacyHash = hashLegacyAuditRecord({
        id: String(legacyLine.id),
        ts: String(legacyLine.ts),
        sessionId: String(legacyLine.sessionId),
        type: String(legacyLine.type),
        payload: legacyPayloadWithoutIntegrity,
        prevHash: null,
      });
      const rewrittenLegacyLine = {
        ...legacyLine,
        payload: {
          ...legacyPayloadWithoutIntegrity,
          __integrity: {
            algo: "sha256",
            prevHash: null,
            hash: legacyHash,
          },
        },
      };
      const legacyText = `${JSON.stringify(rewrittenLegacyLine)}\n`;
      await writeFile(auditPath, legacyText, "utf8");

      const events = await env.store.readAudit(session.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.schemaVersion).toBe(1);

      const verify = await env.store.verifyAuditIntegrity(session.id);
      expect(verify.ok).toBe(true);
    });
  });

  it("detects audit tampering via integrity verification", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      const before = await env.store.verifyAuditIntegrity(session.id);
      expect(before.ok).toBe(true);
      expect(before.eventCount).toBeGreaterThan(0);

      const auditPath = path.join(dataDir, "sessions", session.id, "audit.jsonl");
      const text = await readFile(auditPath, "utf8");
      const tampered = text.replace("repo.readFile", "repo.readFile.tampered");
      await writeFile(auditPath, tampered, "utf8");

      const after = await env.store.verifyAuditIntegrity(session.id);
      expect(after.ok).toBe(false);
      expect(after.failureCode).toBe("hash_mismatch");
      expect(after.reason).toMatch(/mismatch|invalid/i);
    });
  });

  it("classifies audit integrity failures by tamper mode", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(path.join(dataDir, "base"));
      const session = await env.sessions.createSession(repo);
      await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      const auditPath = path.join(dataDir, "base", "sessions", session.id, "audit.jsonl");
      const lines = (await readFile(auditPath, "utf8")).split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(1);

      const parseEnv = createHarborEnvironment(path.join(dataDir, "parse"));
      const parseSession = await parseEnv.sessions.createSession(repo);
      const parsePath = path.join(dataDir, "parse", "sessions", parseSession.id, "audit.jsonl");
      await writeFile(parsePath, "not-json\n", "utf8");
      const parseReport = await parseEnv.store.verifyAuditIntegrity(parseSession.id);
      expect(parseReport.ok).toBe(false);
      expect(parseReport.failureCode).toBe("parse_error");

      const missingEnv = createHarborEnvironment(path.join(dataDir, "missing"));
      const missingSession = await missingEnv.sessions.createSession(repo);
      const missingPath = path.join(dataDir, "missing", "sessions", missingSession.id, "audit.jsonl");
      const missingLine = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      const payload = (missingLine.payload ?? {}) as Record<string, unknown>;
      const { __integrity: _drop, ...payloadWithoutIntegrity } = payload;
      await writeFile(
        missingPath,
        `${JSON.stringify({ ...missingLine, payload: payloadWithoutIntegrity })}\n`,
        "utf8",
      );
      const missingReport = await missingEnv.store.verifyAuditIntegrity(missingSession.id);
      expect(missingReport.ok).toBe(false);
      expect(missingReport.failureCode).toBe("missing_integrity");

      const chainEnv = createHarborEnvironment(path.join(dataDir, "chain"));
      const chainSession = await chainEnv.sessions.createSession(repo);
      const chainPath = path.join(dataDir, "chain", "sessions", chainSession.id, "audit.jsonl");
      const shifted = [...lines.slice(1), lines[0]].join("\n");
      await writeFile(chainPath, `${shifted}\n`, "utf8");
      const chainReport = await chainEnv.store.verifyAuditIntegrity(chainSession.id);
      expect(chainReport.ok).toBe(false);
      expect(chainReport.failureCode).toBe("chain_mismatch");

      const hashEnv = createHarborEnvironment(path.join(dataDir, "hash"));
      const hashSession = await hashEnv.sessions.createSession(repo);
      const hashPath = path.join(dataDir, "hash", "sessions", hashSession.id, "audit.jsonl");
      await writeFile(hashPath, `${lines.join("\n").replace("repo.readFile", "repo.readFile.tampered")}\n`, "utf8");
      const hashReport = await hashEnv.store.verifyAuditIntegrity(hashSession.id);
      expect(hashReport.ok).toBe(false);
      expect(hashReport.failureCode).toBe("hash_mismatch");
    });
  });

  it("records artifact references in capability.result audit payloads for tests.run", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      const run = (await env.invoke(
        session.id,
        "tests.run",
        { adapter: "pnpm-test", args: ["--version"] },
        { approvedAdapters: new Set(["pnpm-test"]) },
      )) as {
        runId: string;
        stdoutArtifactId?: string;
        stderrArtifactId?: string;
      };
      const events = await env.store.readAudit(session.id);
      const resultEvent = [...events]
        .reverse()
        .find((event) => event.type === "capability.result" && event.payload.capabilityName === "tests.run");
      expect(resultEvent).toBeTruthy();
      expect(resultEvent?.payload.runId).toBe(run.runId);
      const refs = Array.isArray(resultEvent?.payload.artifactRefs)
        ? (resultEvent?.payload.artifactRefs as unknown[])
        : [];
      if (run.stdoutArtifactId) {
        expect(refs).toContain(run.stdoutArtifactId);
      }
      if (run.stderrArtifactId) {
        expect(refs).toContain(run.stderrArtifactId);
      }
    });
  });

  it("supports CLI audit inspect/search/replay flows", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
      await env.invoke(
        session.id,
        "tests.run",
        { adapter: "pnpm-test", args: ["--version"] },
        { approvedAdapters: new Set(["pnpm-test"]) },
      );

      const inspectOut = await runHarborCli(
        ["audit", "inspect", session.id, "--data-dir", dataDir, "--type", "capability.call", "--limit", "2", "--verify"],
        repo,
      );
      const inspectJson = JSON.parse(inspectOut.stdout) as {
        returnedEvents: number;
        events: Array<{ type: string }>;
        integrity?: { ok: boolean };
      };
      expect(inspectJson.returnedEvents).toBeGreaterThan(0);
      expect(inspectJson.events.every((event) => event.type === "capability.call")).toBe(true);
      expect(inspectJson.integrity?.ok).toBe(true);

      const searchOut = await runHarborCli(
        ["audit", "search", session.id, "--data-dir", dataDir, "--query", "tests.run"],
        repo,
      );
      const searchJson = JSON.parse(searchOut.stdout) as {
        matchCount: number;
        matches: Array<{ payload: { capabilityName?: string } }>;
      };
      expect(searchJson.matchCount).toBeGreaterThan(0);
      expect(searchJson.matches.some((m) => m.payload.capabilityName === "tests.run")).toBe(true);

      const replayOut = await runHarborCli(
        ["audit", "replay", session.id, "--data-dir", dataDir],
        repo,
      );
      expect(replayOut.stdout).toContain("Replay Summary");
      const replayJson = parseLastJsonObject(replayOut.stdout) as {
        timeline: {
          modelRuns: { total: number };
          approvals: { granted: number };
          publish: { applied: number };
          capabilityCalls: Array<{ capabilityName: string; count: number }>;
        };
      };
      expect(replayJson.timeline.modelRuns.total).toBeGreaterThanOrEqual(0);
      expect(replayJson.timeline.approvals.granted).toBeGreaterThanOrEqual(0);
      expect(replayJson.timeline.publish.applied).toBeGreaterThanOrEqual(0);
      expect(
        replayJson.timeline.capabilityCalls.some((entry) => entry.capabilityName === "tests.run"),
      ).toBe(true);
    });
  });

  it("supports inspect -> draft -> test -> review -> publish CLI flow with review JSON mode", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const initOut = await runHarborCli(["init", repo, "--data-dir", dataDir], repo);
      const initJson = JSON.parse(initOut.stdout) as { session: { id: string } };
      const sessionId = initJson.session.id;

      const readOut = await runHarborCli(["read", sessionId, "hello.txt", "--repo", "--data-dir", dataDir], repo);
      expect(readOut.stdout).toContain("Next:");
      const readJson = parseLastJsonObject(readOut.stdout) as { status: string; value: { content: string } };
      expect(readJson.status).toBe("ok");
      expect(readJson.value.content).toBe("base\n");

      const writeOut = await runHarborCli(
        ["write", sessionId, "hello.txt", "--content", "changed\n", "--data-dir", dataDir],
        repo,
      );
      expect(writeOut.stdout).toContain("Next:");
      expect((parseLastJsonObject(writeOut.stdout) as { status: string }).status).toBe("ok");

      const diffOut = await runHarborCli(["diff", sessionId, "--data-dir", dataDir], repo);
      expect(diffOut.stdout).toContain("Next:");
      expect((parseLastJsonObject(diffOut.stdout) as { status: string }).status).toBe("ok");

      await runHarborCli(["test", sessionId, "pnpm-test", "--approve", "--data-dir", dataDir], repo);

      const reviewOut = await runHarborCli(["review", sessionId, "--data-dir", dataDir], repo);
      const normalized = normalizeDynamic(reviewOut.stdout);
      expect(normalized).toContain("Task Summary:");
      expect(normalized).toContain("Changed Files:");
      expect(normalized).toContain("Diff Summary:");
      expect(normalized).toContain("Test Outcome:");
      expect(normalized).toContain("Publish Intent:");
      expect(normalized).toContain("Next:");

      const reviewJsonOut = await runHarborCli(["review", sessionId, "--json", "--data-dir", dataDir], repo);
      const reviewJson = JSON.parse(reviewJsonOut.stdout) as {
        status: string;
        taskSummary: { changeCount: number };
        diffSummary: { fileCount: number };
      };
      expect(reviewJson.status).toBe("ok");
      expect(reviewJson.taskSummary.changeCount).toBeGreaterThan(0);
      expect(reviewJson.diffSummary.fileCount).toBeGreaterThan(0);

      const publishOut = await runHarborCli(
        ["publish", sessionId, "--approve", "--yes", "--data-dir", dataDir],
        repo,
      );
      const publishJson = parseLastJsonObject(publishOut.stdout) as { status: string };
      expect(publishJson.status).toBe("ok");
      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("changed\n");
    });
  });

  it("supports run --file flow and verbose review details", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      const taskPath = path.join(repo, "task.js");
      await writeFile(
        taskPath,
        [
          'const file = await harbor.invoke("repo.readFile", { path: "hello.txt" });',
          'await harbor.invoke("workspace.writeFile", { path: "hello.txt", content: file.content.toUpperCase() });',
          'return await harbor.invoke("publish.preview", {});',
        ].join("\n"),
        "utf8",
      );

      const runOut = await runHarborCli(
        ["run", session.id, "--file", taskPath, "--data-dir", dataDir],
        repo,
      );
      expect(runOut.stdout).toContain("Next:");
      expect((parseLastJsonObject(runOut.stdout) as { status: string }).status).toBe("ok");

      const reviewOut = await runHarborCli(
        ["review", session.id, "--verbose", "--data-dir", dataDir],
        repo,
      );
      expect(reviewOut.stdout).toContain("Diff Details:");
    });
  });

  it("emits validation taxonomy for task scope without task-id", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      const out = await runHarborCli(
        ["test", session.id, "pnpm-test", "--approve-scope", "task", "--data-dir", dataDir],
        repo,
        { expectFailure: true },
      );
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("[validation_error]");
      const json = parseLastJsonObject(out.stdout) as { category: string; errorCode: string };
      expect(json.category).toBe("validation_error");
      expect(json.errorCode).toBe("approval.scope.task_id_required");
    });
  });

  it("emits approval-required taxonomy and remediation hints for publish without grant", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      await env.invoke(session.id, "workspace.writeFile", { path: "hello.txt", content: "pending\n" });

      const out = await runHarborCli(
        ["publish", session.id, "--yes", "--data-dir", dataDir],
        repo,
      );
      const json = parseLastJsonObject(out.stdout) as {
        status: string;
        category?: string;
        errorCode?: string;
        nextAction?: string;
      };
      expect(json.status).toBe("approval_required");
      expect(json.category).toBe("approval_required");
      expect(json.errorCode).toBe("approval.required");
      expect((json.nextAction ?? "").toLowerCase()).toContain("review");
    });
  });

  it("supports discard + reject + revise + approvals revoke flow", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      await runHarborCli(
        ["write", session.id, "hello.txt", "--content", "draft-1\n", "--data-dir", dataDir],
        repo,
      );

      const rejectOut = await runHarborCli(
        ["reject", session.id, "--reason", "not ready", "--data-dir", dataDir],
        repo,
      );
      expect((parseLastJsonObject(rejectOut.stdout) as { status: string }).status).toBe("ok");

      const reviseOut = await runHarborCli(
        ["revise", session.id, "--note", "try smaller diff", "--data-dir", dataDir],
        repo,
      );
      expect((parseLastJsonObject(reviseOut.stdout) as { status: string }).status).toBe("ok");

      const discardOut = await runHarborCli(["discard", session.id, "hello.txt", "--data-dir", dataDir], repo);
      expect((parseLastJsonObject(discardOut.stdout) as { status: string }).status).toBe("ok");

      await runHarborCli(
        ["write", session.id, "hello.txt", "--content", "publishable\n", "--data-dir", dataDir],
        repo,
      );
      await runHarborCli(
        ["publish", session.id, "--approve", "--approve-scope", "session", "--yes", "--data-dir", dataDir],
        repo,
      );
      const revokeOut = await runHarborCli(
        ["approvals", "revoke", session.id, "--all", "--reason", "cleanup", "--data-dir", dataDir],
        repo,
      );
      const revokeJson = parseLastJsonObject(revokeOut.stdout) as { status: string; value: { revokedCount: number } };
      expect(revokeJson.status).toBe("ok");
      expect(revokeJson.value.revokedCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows policy preset impact in strict mode and keeps help text coherent", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const initOut = await runHarborCli(
        ["init", repo, "--data-dir", dataDir, "--policy-preset", "strict"],
        repo,
      );
      const sessionId = (JSON.parse(initOut.stdout) as { session: { id: string } }).session.id;

      const strictTest = await runHarborCli(
        ["test", sessionId, "pnpm-test", "--data-dir", dataDir, "--policy-preset", "strict"],
        repo,
      );
      const strictJson = parseLastJsonObject(strictTest.stdout) as {
        status: string;
        category?: string;
        errorCode?: string;
      };
      expect(strictJson.status).toBe("approval_required");
      expect(strictJson.category).toBe("approval_required");
      expect(strictJson.errorCode).toBe("approval.required");

      const helpOut = await runHarborCli(["help"], repo);
      expect(helpOut.stdout).toContain("harbor review <session-id> [--json] [--verbose]");
      expect(helpOut.stdout).toContain("Core Flow (inspect -> draft -> test -> review -> publish)");
    });
  });

  it("returns bridge taxonomy metadata for approval and capability errors via CLI paths", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const initOut = await runHarborCli(["init", repo, "--data-dir", dataDir], repo);
      const sessionId = (JSON.parse(initOut.stdout) as { session: { id: string } }).session.id;
      await runHarborCli(
        ["write", sessionId, "hello.txt", "--content", "from-bridge\n", "--data-dir", dataDir],
        repo,
      );

      const approvalOut = await runHarborCli(
        ["publish", sessionId, "--yes", "--data-dir", dataDir],
        repo,
      );
      const approval = parseLastJsonObject(approvalOut.stdout) as {
        status: string;
        category?: string;
        errorCode?: string;
      };
      expect(approval.status).toBe("approval_required");
      expect(approval.category).toBe("approval_required");
      expect(approval.errorCode).toBe("approval.required");

      const capabilityOut = await runHarborCli(
        ["call", sessionId, "missing.capability", "--data-dir", dataDir],
        repo,
      );
      const capability = parseLastJsonObject(capabilityOut.stdout) as {
        status: string;
        category?: string;
        errorCode?: string;
      };
      expect(capability.status).toBe("validation_error");
      expect(capability.category).toBe("capability_error");
      expect(capability.errorCode).toBe("capability.not_found");
    });
  });

  it("uses adversarial repo fixtures as untrusted data and keeps publish gated", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      await seedAdversarialFixture(repo);
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const run = await env.runModelTask(
        session.id,
        [
          "const injected = await harbor.invoke('repo.readFile', { path: 'INJECTION.md' });",
          "await harbor.invoke('workspace.writeFile', { path: 'notes.txt', content: injected.content.slice(0, 80) });",
          "return await harbor.invoke('publish.apply', {});",
        ].join("\n"),
      );

      expect(run.ok).toBe(false);
      expect(run.error ?? "").toMatch(/publish draft changes to repo/i);
      await expect(access(path.join(repo, "notes.txt"))).rejects.toThrow();
    });
  });

  it("prevents model runtime authority escapes via function constructor paths", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const run = await env.runModelTask(
        session.id,
        [
          "const Fn = ({}).constructor.constructor;",
          "const fs = Fn(\"return require('node:fs')\")();",
          "fs.writeFileSync('escape.txt', 'pwned');",
          "return true;",
        ].join("\n"),
      );

      expect(run.ok).toBe(false);
      expect(run.error ?? "").toMatch(/require|undefined|not defined/i);
      await expect(access(path.join(repo, "escape.txt"))).rejects.toThrow();
    });
  });

  it("invoke bridge can be used from synchronous sandbox code that returns promises to host", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      const harbor = createHarborInvokeBridge(env, session.id);

      const promise = evalInTestSandbox<Promise<{ content: string }>>(
        "harbor.invoke('repo.readFile', { path: 'hello.txt' })",
        { globals: { harbor } },
      );

      const out = await promise;
      expect(out.content).toBe("base\n");
    });
  });
});

describe("temp repo fixture", () => {
  it("creates isolated repo path", async () => {
    await withTempRepo(async ({ repo }) => {
      const p = path.join(repo, "marker.txt");
      await writeFile(p, "x", "utf8");
      expect(await readFile(p, "utf8")).toBe("x");
    });
  });
});
