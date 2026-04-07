import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApprovalRequiredError, ValidationError } from "@openharbor/core";
import { createHarborEnvironment } from "@openharbor/host";
import { createHarborInvokeBridge } from "./harbor-bridge.js";
import { evalInTestSandbox } from "./vm-sandbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adversarialFixtureDir = path.resolve(__dirname, "../fixtures/adversarial-repo");

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
      expect(after.reason).toMatch(/mismatch|invalid/i);
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
