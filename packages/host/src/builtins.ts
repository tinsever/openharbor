import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { z } from "zod";
import { normalizeRepoRelative } from "@openharbor/overlay";
import type { CapabilityDescriptor } from "@openharbor/schemas";
import type { CapabilityHost, InvokeContext } from "./capability-host.js";
import { makeAuditEvent } from "./audit.js";

function resolveUnderRepo(repoRoot: string, rel: string): string {
  const normalized = normalizeRepoRelative(rel);
  const parts = normalized.split("/").filter(Boolean);
  const abs = path.resolve(path.join(repoRoot, ...parts));
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repository root: ${rel}`);
  }
  return abs;
}

function toRepoRelative(repoRoot: string, abs: string): string {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(abs));
  if (!rel || rel === ".") {
    return ".";
  }
  return rel.split(path.sep).join("/");
}

const REPO_NOISE_SEGMENTS = new Set([
  ".git",
  ".harbor-data",
  ".pnpm-store",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "dist",
  "node_modules",
]);

const SOURCE_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const PRIORITY_DIR_SEGMENTS = new Set([
  "app",
  "apps",
  "api",
  "client",
  "clients",
  "lib",
  "libs",
  "package",
  "packages",
  "server",
  "services",
  "src",
  "web",
]);

function isRepoNoisePath(repoRelativePath: string): boolean {
  const normalized = repoRelativePath.replace(/\\/g, "/");
  if (normalized === "." || normalized === "") {
    return false;
  }
  return normalized.split("/").filter(Boolean).some((segment) => REPO_NOISE_SEGMENTS.has(segment));
}

function shouldHideRepoEntry(parentPath: string, entryPath: string): boolean {
  if (isRepoNoisePath(parentPath)) {
    return false;
  }
  return isRepoNoisePath(entryPath);
}

function scoreRepoTraversalPath(repoRelativePath: string, query: string, isDirectory: boolean): number {
  const normalized = repoRelativePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const queryLower = query.toLowerCase();
  const base = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(normalized).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  let score = isDirectory ? 25 : 0;

  if (!isRepoNoisePath(normalized)) {
    score += 100;
  }
  if (lower.includes(queryLower)) {
    score += 70;
  }
  if (base === queryLower || lower.endsWith(`/${queryLower}`)) {
    score += 60;
  }
  if (segments.some((segment) => PRIORITY_DIR_SEGMENTS.has(segment.toLowerCase()))) {
    score += 45;
  }
  if (!isDirectory && SOURCE_FILE_EXTENSIONS.has(ext)) {
    score += 20;
  }
  if (base === "package.json" || base === "readme.md") {
    score += 10;
  }
  if (base === "pnpm-lock.yaml" || lower.endsWith(".log")) {
    score -= 80;
  }

  return score;
}

const TEST_ADAPTERS: Record<string, { command: string; args: string[]; description: string }> = {
  "pnpm-test": {
    command: "pnpm",
    args: ["test"],
    description: "Run repository tests via pnpm test",
  },
  "npm-test": {
    command: "npm",
    args: ["test"],
    description: "Run repository tests via npm test",
  },
  vitest: {
    command: "pnpm",
    args: ["vitest", "run"],
    description: "Run Vitest in run mode",
  },
};

async function runCommandWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options?: { disableNetwork?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const env = await buildChildEnv(options?.disableNetwork ?? false);
  return await new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : 1,
        timedOut: signal === "SIGTERM",
      });
    });

    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: stderr.length > 0 ? stderr : String(err),
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

let networkLockdownScriptPath: string | null = null;
let networkLockdownScriptPromise: Promise<string> | null = null;

async function buildChildEnv(disableNetwork: boolean): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
  };
  if (!disableNetwork) {
    return env;
  }

  const lockdownScript = await ensureNetworkLockdownScript();
  const nodeOptions = (process.env.NODE_OPTIONS ?? "").trim();
  env.NODE_OPTIONS = `${nodeOptions ? `${nodeOptions} ` : ""}--require ${quoteNodeOptionArg(lockdownScript)}`.trim();
  env.HTTP_PROXY = "";
  env.HTTPS_PROXY = "";
  env.ALL_PROXY = "";
  env.NO_PROXY = "*";
  env.npm_config_offline = "true";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.YARN_ENABLE_NETWORK = "0";
  return env;
}

async function ensureNetworkLockdownScript(): Promise<string> {
  if (networkLockdownScriptPath) {
    return networkLockdownScriptPath;
  }
  if (networkLockdownScriptPromise) {
    return networkLockdownScriptPromise;
  }
  networkLockdownScriptPromise = (async () => {
    const file = path.join(os.tmpdir(), `openharbor-network-lockdown-${process.pid}.cjs`);
    const source = [
      '"use strict";',
      "const disabled = () => { throw new Error('Network access is disabled by OpenHarbor test adapter'); };",
      "try {",
      "  const net = require('node:net');",
      "  net.connect = disabled;",
      "  net.createConnection = disabled;",
      "} catch {}",
      "try {",
      "  const dns = require('node:dns');",
      "  dns.lookup = disabled;",
      "  dns.resolve = disabled;",
      "} catch {}",
      "try {",
      "  const http = require('node:http');",
      "  const https = require('node:https');",
      "  http.request = disabled;",
      "  http.get = disabled;",
      "  https.request = disabled;",
      "  https.get = disabled;",
      "} catch {}",
      "if (typeof globalThis === 'object' && globalThis) {",
      "  globalThis.fetch = disabled;",
      "  globalThis.WebSocket = disabled;",
      "}",
    ].join("\n");
    await fs.writeFile(file, source, { encoding: "utf8", mode: 0o600 });
    networkLockdownScriptPath = file;
    return file;
  })();
  try {
    return await networkLockdownScriptPromise;
  } finally {
    networkLockdownScriptPromise = null;
  }
}

function quoteNodeOptionArg(value: string): string {
  if (!value.includes(" ")) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function pruneEmptyParentDirs(repoRoot: string, fileAbsPath: string): Promise<void> {
  const root = path.resolve(repoRoot);
  let current = path.dirname(path.resolve(fileAbsPath));
  while (current.startsWith(root + path.sep)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) {
        break;
      }
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

/**
 * Minimal v0 capability implementations (typed host-side; not model runtime).
 */
export function registerBuiltinCapabilities(host: CapabilityHost): CapabilityDescriptor[] {
  const before = new Set(host.listDescriptors().map((item) => item.name));
  host.register({
    name: "artifacts.put",
    description: "Store text content as a session artifact",
    effect: { effectClass: "write.artifact" },
    input: z.object({
      content: z.string(),
      mimeType: z.string().default("text/plain"),
    }),
    output: z.object({
      artifactId: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    }),
    resolveTarget: (_input, session) => ({
      kind: "artifact" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      const artifactId = randomUUID();
      const saved = await ctx.store.putArtifact(ctx.session.id, {
        id: artifactId,
        mimeType: input.mimeType ?? "text/plain",
        content: input.content,
      });
      return {
        artifactId: saved.id,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      };
    },
  });

  host.register({
    name: "artifacts.get",
    description: "Load artifact content by ID",
    effect: { effectClass: "read.artifact" },
    input: z.object({ artifactId: z.string() }),
    output: z.object({
      found: z.boolean(),
      artifactId: z.string().optional(),
      mimeType: z.string().optional(),
      content: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "artifact" as const,
      id: input.artifactId,
    }),
    handler: async (input, ctx) => {
      const artifact = await ctx.store.getArtifact(ctx.session.id, input.artifactId);
      if (!artifact) {
        return { found: false as const };
      }
      return {
        found: true as const,
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        content: artifact.content,
        sizeBytes: artifact.sizeBytes,
      };
    },
  });

  host.register({
    name: "artifacts.list",
    description: "List artifact metadata",
    effect: { effectClass: "read.artifact" },
    input: z.object({}),
    output: z.object({
      artifacts: z.array(
        z.object({
          artifactId: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int().nonnegative(),
          createdAt: z.string(),
        }),
      ),
    }),
    resolveTarget: (_input, session) => ({
      kind: "artifact" as const,
      id: session.id,
    }),
    handler: async (_input, ctx) => {
      const artifacts = await ctx.store.listArtifacts(ctx.session.id);
      return {
        artifacts: artifacts.map((item) => ({
          artifactId: item.id,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          createdAt: item.createdAt,
        })),
      };
    },
  });

  host.register({
    name: "repo.listDir",
    description: "List files/directories under a repository path",
    effect: { effectClass: "read.repo" },
    input: z.object({
      path: z.string().default("."),
    }),
    output: z.object({
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          type: z.enum(["file", "dir", "other"]),
          size: z.number().nullable(),
        }),
      ),
    }),
    resolveTarget: (input, _session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: input.path ?? ".",
    }),
    handler: async (input, ctx: InvokeContext) => {
      const relPath = input.path ?? ".";
      const base = resolveUnderRepo(ctx.session.repoPath, relPath);
      const entries = await fs.readdir(base, { withFileTypes: true });
      const out = await Promise.all(
        entries.map(async (entry) => {
          const abs = path.join(base, entry.name);
          let size: number | null = null;
          if (entry.isFile()) {
            size = (await fs.stat(abs)).size;
          }
          const relPath = toRepoRelative(ctx.session.repoPath, abs);
          return {
            name: entry.name,
            path: relPath,
            type: entry.isDirectory()
              ? ("dir" as const)
              : entry.isFile()
                ? ("file" as const)
                : ("other" as const),
            size,
          };
        }),
      );
      const visible = out
        .filter((entry) => !shouldHideRepoEntry(relPath, entry.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { entries: visible };
    },
  });

  host.register({
    name: "repo.stat",
    description: "Stat a repository path",
    effect: { effectClass: "read.repo" },
    input: z.object({ path: z.string() }),
    output: z.object({
      exists: z.boolean(),
      type: z.enum(["file", "dir", "other"]).optional(),
      size: z.number().optional(),
      mtimeMs: z.number().optional(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: input.path,
    }),
    handler: async (input, ctx: InvokeContext) => {
      const abs = resolveUnderRepo(ctx.session.repoPath, input.path);
      try {
        const st = await fs.stat(abs);
        return {
          exists: true as const,
          type: st.isDirectory() ? ("dir" as const) : st.isFile() ? ("file" as const) : ("other" as const),
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      } catch {
        return { exists: false as const };
      }
    },
  });

  host.register({
    name: "repo.search",
    description: "Search text in repository files under a bounded scope",
    effect: { effectClass: "read.repo" },
    input: z.object({
      query: z.string().min(1),
      path: z.string().default("."),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().positive().max(1_000).default(100),
      maxFiles: z.number().int().positive().max(10_000).default(5_000),
      maxFileSizeBytes: z.number().int().positive().max(5_000_000).default(256_000),
    }),
    output: z.object({
      matches: z.array(
        z.object({
          path: z.string(),
          lineNumber: z.number().int().positive(),
          line: z.string(),
        }),
      ),
      scannedFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: input.path ?? ".",
    }),
    handler: async (input, ctx: InvokeContext) => {
      const relPath = input.path ?? ".";
      const maxResults = input.maxResults ?? 100;
      const maxFiles = input.maxFiles ?? 5_000;
      const maxFileSizeBytes = input.maxFileSizeBytes ?? 256_000;
      const root = resolveUnderRepo(ctx.session.repoPath, relPath);
      const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
      let scannedFiles = 0;
      let truncated = false;
      const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
      const rootStat = await fs.stat(root);
      const rootRepoPath = toRepoRelative(ctx.session.repoPath, root);
      const stack = rootStat.isDirectory() ? [root] : [];

      const scanFile = async (abs: string): Promise<void> => {
        const repoFilePath = toRepoRelative(ctx.session.repoPath, abs);
        if (isRepoNoisePath(repoFilePath) && !isRepoNoisePath(rootRepoPath)) {
          return;
        }
        const stat = await fs.stat(abs);
        if (stat.size > maxFileSizeBytes) {
          return;
        }

        const raw = await fs.readFile(abs);
        if (raw.includes(0)) {
          return;
        }

        scannedFiles += 1;
        const text = raw.toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          const haystack = input.caseSensitive ? line : line.toLowerCase();
          if (!haystack.includes(needle)) {
            continue;
          }
          matches.push({
            path: repoFilePath,
            lineNumber: i + 1,
            line,
          });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      };

      if (rootStat.isFile()) {
        await scanFile(root);
        return { matches, scannedFiles, truncated };
      }

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          continue;
        }
        const entries = (await fs.readdir(current, { withFileTypes: true }))
          .sort((a, b) => {
            const aPath = toRepoRelative(ctx.session.repoPath, path.join(current, a.name));
            const bPath = toRepoRelative(ctx.session.repoPath, path.join(current, b.name));
            const scoreDelta = scoreRepoTraversalPath(bPath, input.query, b.isDirectory())
              - scoreRepoTraversalPath(aPath, input.query, a.isDirectory());
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            return a.name.localeCompare(b.name);
          });
        for (const entry of entries) {
          if (matches.length >= maxResults || scannedFiles >= maxFiles) {
            truncated = true;
            break;
          }

          const abs = path.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }
          if (entry.isDirectory()) {
            const repoDirPath = toRepoRelative(ctx.session.repoPath, abs);
            if (isRepoNoisePath(repoDirPath) && !isRepoNoisePath(rootRepoPath)) {
              continue;
            }
            stack.push(abs);
            continue;
          }
          if (!entry.isFile()) {
            continue;
          }
          await scanFile(abs);
        }
        if (truncated) {
          break;
        }
      }

      return { matches, scannedFiles, truncated };
    },
  });

  host.register({
    name: "repo.readFile",
    description: "Read a file from the read-only mounted repository",
    effect: { effectClass: "read.repo" },
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    resolveTarget: (input, _session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: input.path,
    }),
    handler: async (input, ctx: InvokeContext) => {
      const abs = resolveUnderRepo(ctx.session.repoPath, input.path);
      const content = await fs.readFile(abs, "utf8");
      return { content };
    },
  });

  host.register({
    name: "workspace.readFile",
    description: "Read a file through overlay resolution (draft first, then repo)",
    effect: { effectClass: "read.draft" },
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    resolveTarget: (input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
      path: input.path,
    }),
    handler: async (input, ctx) => {
      const content = await ctx.overlay.readFile(input.path);
      return { content };
    },
  });

  host.register({
    name: "workspace.writeFile",
    description: "Write draft content into the session overlay",
    effect: { effectClass: "write.draft" },
    input: z.object({ path: z.string(), content: z.string() }),
    output: z.object({ ok: z.literal(true) }),
    resolveTarget: (input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
      path: input.path,
    }),
    handler: async (input, ctx) => {
      ctx.overlay.writeFile(input.path, input.content);
      await ctx.persistWorkspace();
      return { ok: true as const };
    },
  });

  host.register({
    name: "workspace.applyPatch",
    description: "Apply a structured multi-file patch to the overlay",
    effect: { effectClass: "write.draft" },
    input: z.object({
      changes: z.array(
        z.object({
          path: z.string(),
          content: z.string().optional(),
          delete: z.boolean().optional(),
        }),
      ),
    }),
    output: z.object({ applied: z.number().int().nonnegative() }),
    resolveTarget: (_input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
    }),
    handler: async (input, ctx) => {
      let applied = 0;
      for (const change of input.changes) {
        if (change.delete) {
          await ctx.overlay.deleteFile(change.path);
          applied += 1;
          continue;
        }
        if (change.content === undefined) {
          throw new Error(`workspace.applyPatch requires content for non-delete change: ${change.path}`);
        }
        ctx.overlay.writeFile(change.path, change.content);
        applied += 1;
      }
      await ctx.persistWorkspace();
      return { applied };
    },
  });

  host.register({
    name: "workspace.deleteFile",
    description: "Delete a file in draft overlay state",
    effect: { effectClass: "write.draft" },
    input: z.object({ path: z.string() }),
    output: z.object({ ok: z.literal(true) }),
    resolveTarget: (input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
      path: input.path,
    }),
    handler: async (input, ctx) => {
      await ctx.overlay.deleteFile(input.path);
      await ctx.persistWorkspace();
      return { ok: true as const };
    },
  });

  host.register({
    name: "workspace.deletePath",
    description: "Delete a file or directory subtree in draft overlay state",
    effect: { effectClass: "write.draft" },
    input: z.object({
      path: z.string(),
      recursive: z.boolean().default(true),
    }),
    output: z.object({
      ok: z.literal(true),
      deleted: z.number().int().nonnegative(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
      path: input.path,
    }),
    handler: async (input, ctx) => {
      const deleted = await ctx.overlay.deletePath(input.path, input.recursive ?? true);
      await ctx.persistWorkspace();
      return { ok: true as const, deleted };
    },
  });

  host.register({
    name: "workspace.listChanges",
    description: "List pending overlay changes",
    effect: { effectClass: "read.draft" },
    input: z.object({}),
    output: z.object({
      changes: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["modify", "create", "delete"]),
        }),
      ),
    }),
    resolveTarget: (_input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
    }),
    handler: async (_input, ctx) => {
      const changes = await ctx.overlay.listChangesResolved();
      return {
        changes: changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        })),
      };
    },
  });

  host.register({
    name: "workspace.reset",
    description: "Discard all overlay changes or selected paths",
    effect: { effectClass: "write.draft" },
    input: z.object({
      paths: z.array(z.string()).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
    resolveTarget: (_input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
    }),
    handler: async (input, ctx) => {
      ctx.overlay.reset(input.paths);
      await ctx.persistWorkspace();
      return { ok: true as const };
    },
  });

  host.register({
    name: "workspace.diff",
    description: "Structured diff of overlay vs base repository",
    effect: { effectClass: "read.draft" },
    input: z.object({}),
    output: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
        }),
      ),
    }),
    resolveTarget: (_input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
    }),
    handler: async (_input, ctx) => {
      const files = await ctx.overlay.diffAll();
      return { files };
    },
  });

  host.register({
    name: "tests.listAdapters",
    description: "List available test adapters",
    effect: { effectClass: "read.repo" },
    input: z.object({}),
    output: z.object({
      adapters: z.array(
        z.object({
          name: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          description: z.string(),
        }),
      ),
    }),
    resolveTarget: (_input, _session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: ".",
    }),
    handler: async () => {
      const adapters = Object.entries(TEST_ADAPTERS).map(([name, def]) => ({
        name,
        command: def.command,
        args: def.args,
        description: def.description,
      }));
      adapters.sort((a, b) => a.name.localeCompare(b.name));
      return { adapters };
    },
  });

  host.register({
    name: "tests.run",
    description: "Run tests via an approved adapter and store outputs as artifacts",
    effect: { effectClass: "execute.adapter" },
    input: z.object({
      adapter: z.string(),
      args: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    }),
    output: z.object({
      runId: z.string(),
      adapter: z.string(),
      ok: z.boolean(),
      exitCode: z.number(),
      timedOut: z.boolean(),
      stdoutArtifactId: z.string().optional(),
      stderrArtifactId: z.string().optional(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "adapter" as const,
      id: input.adapter,
    }),
    handler: async (input, ctx) => {
      const adapter = TEST_ADAPTERS[input.adapter];
      if (!adapter) {
        throw new Error(`Unknown test adapter: ${input.adapter}`);
      }
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const args = input.args ?? adapter.args;
      const timeoutMs = input.timeoutMs ?? 60_000;
      const result = await runCommandWithTimeout(
        adapter.command,
        args,
        ctx.session.repoPath,
        timeoutMs,
        { disableNetwork: true },
      );
      const finishedAt = new Date().toISOString();

      let stdoutArtifactId: string | undefined;
      if (result.stdout.length > 0) {
        stdoutArtifactId = randomUUID();
        await ctx.store.putArtifact(ctx.session.id, {
          id: stdoutArtifactId,
          mimeType: "text/plain",
          content: result.stdout,
        });
      }

      let stderrArtifactId: string | undefined;
      if (result.stderr.length > 0) {
        stderrArtifactId = randomUUID();
        await ctx.store.putArtifact(ctx.session.id, {
          id: stderrArtifactId,
          mimeType: "text/plain",
          content: result.stderr,
        });
      }

      await ctx.store.saveTestRun(ctx.session.id, {
        runId,
        adapter: input.adapter,
        command: adapter.command,
        args,
        cwd: ctx.session.repoPath,
        startedAt,
        finishedAt,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutArtifactId,
        stderrArtifactId,
      });

      return {
        runId,
        adapter: input.adapter,
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutArtifactId,
        stderrArtifactId,
      };
    },
  });

  host.register({
    name: "tests.getResult",
    description: "Get a previously recorded test run result",
    effect: { effectClass: "read.artifact" },
    input: z.object({ runId: z.string() }),
    output: z.object({
      found: z.boolean(),
      run: z
        .object({
          runId: z.string(),
          adapter: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          cwd: z.string(),
          startedAt: z.string(),
          finishedAt: z.string(),
          ok: z.boolean(),
          exitCode: z.number(),
          timedOut: z.boolean(),
          stdoutArtifactId: z.string().optional(),
          stderrArtifactId: z.string().optional(),
        })
        .optional(),
    }),
    resolveTarget: (input, _session) => ({
      kind: "artifact" as const,
      id: input.runId,
    }),
    handler: async (input, ctx) => {
      const run = await ctx.store.getTestRun(ctx.session.id, input.runId);
      if (!run) {
        return { found: false as const };
      }
      return { found: true as const, run };
    },
  });

  host.register({
    name: "tests.listRuns",
    description: "List recorded test runs for the session",
    effect: { effectClass: "read.artifact" },
    input: z.object({
      limit: z.number().int().positive().max(200).default(20),
    }),
    output: z.object({
      runs: z.array(
        z.object({
          runId: z.string(),
          adapter: z.string(),
          startedAt: z.string(),
          finishedAt: z.string(),
          ok: z.boolean(),
          exitCode: z.number(),
          timedOut: z.boolean(),
          stdoutArtifactId: z.string().optional(),
          stderrArtifactId: z.string().optional(),
        }),
      ),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      const runs = await ctx.store.listTestRuns(ctx.session.id);
      const recent = [...runs]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, input.limit ?? 20);
      return {
        runs: recent.map((run) => ({
          runId: run.runId,
          adapter: run.adapter,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ok: run.ok,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stdoutArtifactId: run.stdoutArtifactId,
          stderrArtifactId: run.stderrArtifactId,
        })),
      };
    },
  });

  host.register({
    name: "approvals.list",
    description: "List approval grants issued for this Harbor session",
    effect: { effectClass: "read.artifact" },
    input: z.object({
      includeInactive: z.boolean().default(true),
    }),
    output: z.object({
      grants: z.array(
        z.object({
          id: z.string().uuid(),
          scope: z.enum(["once", "task", "session"]),
          effectClass: z.string(),
          targetId: z.string(),
          taskId: z.string().optional(),
          status: z.enum(["active", "consumed", "revoked"]),
          issuedAt: z.string(),
          consumedAt: z.string().optional(),
          revokedAt: z.string().optional(),
          reason: z.string().optional(),
        }),
      ),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      const grants = ctx.sessions.listApprovalGrants(ctx.session.id, {
        includeInactive: input.includeInactive ?? true,
      });
      return { grants };
    },
  });

  host.register({
    name: "approvals.revoke",
    description: "Revoke active approval grants by id, task, or entire session",
    effect: { effectClass: "write.artifact" },
    input: z
      .object({
        grantId: z.string().uuid().optional(),
        taskId: z.string().optional(),
        all: z.boolean().optional(),
        reason: z.string().optional(),
      })
      .superRefine((input, issue) => {
        const selectors = [input.grantId ? 1 : 0, input.taskId ? 1 : 0, input.all ? 1 : 0].reduce(
          (sum, item) => sum + item,
          0,
        );
        if (selectors !== 1) {
          issue.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Exactly one of grantId, taskId, or all=true must be provided",
          });
        }
      }),
    output: z.object({
      revokedCount: z.number().int().nonnegative(),
      grantIds: z.array(z.string().uuid()),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      let revoked = [] as Array<{ id: string }>;
      if (input.grantId) {
        const hit = ctx.sessions.revokeApprovalGrant(ctx.session.id, input.grantId, input.reason);
        revoked = hit ? [{ id: hit.id }] : [];
      } else if (input.taskId) {
        revoked = ctx.sessions
          .revokeApprovalGrantsByTask(ctx.session.id, input.taskId, input.reason)
          .map((grant) => ({ id: grant.id }));
      } else if (input.all) {
        revoked = ctx.sessions
          .revokeAllApprovalGrants(ctx.session.id, input.reason)
          .map((grant) => ({ id: grant.id }));
      }

      if (revoked.length > 0) {
        await ctx.sessions.persistApprovalGrants(ctx.session.id);
        for (const grant of revoked) {
          await ctx.store.appendAudit(
            ctx.session.id,
            makeAuditEvent(ctx.session.id, "approval.revoked", {
              grantId: grant.id,
              reason: input.reason ?? null,
            }),
          );
        }
      }

      return {
        revokedCount: revoked.length,
        grantIds: revoked.map((grant) => grant.id),
      };
    },
  });

  host.register({
    name: "publish.preview",
    description: "Summarize what would be published (does not mutate the repo)",
    effect: { effectClass: "read.draft" },
    input: z.object({}),
    output: z.object({
      changeCount: z.number(),
      paths: z.array(z.string()),
      files: z.array(z.object({
        path: z.string(),
        hunkCount: z.number().int().nonnegative(),
        addedLines: z.number().int().nonnegative(),
        removedLines: z.number().int().nonnegative(),
      })),
      summary: z.object({
        fileCount: z.number().int().nonnegative(),
        addedLines: z.number().int().nonnegative(),
        removedLines: z.number().int().nonnegative(),
      }),
    }),
    resolveTarget: (_input, _session) => ({
      kind: "overlay_path" as const,
      id: "overlay",
    }),
    handler: async (_input, ctx) => {
      const changes = await ctx.overlay.listChangesResolved();
      const diffs = await ctx.overlay.diffAll();
      return {
        changeCount: changes.length,
        paths: changes.map((c) => c.path),
        files: diffs.map((file) => ({
          path: file.path,
          hunkCount: file.hunks.length,
          addedLines: countPrefixedLines(file.hunks, "+"),
          removedLines: countPrefixedLines(file.hunks, "-"),
        })),
        summary: {
          fileCount: diffs.length,
          addedLines: countDiffLines(diffs, "+"),
          removedLines: countDiffLines(diffs, "-"),
        },
      };
    },
  });

  host.register({
    name: "publish.request",
    description: "Request approval to publish overlay drafts to the repository",
    effect: { effectClass: "publish.repo", requiresApprovalByDefault: true },
    input: z.object({}),
    output: z.object({ requested: z.literal(true) }),
    resolveTarget: (_input, session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: session.repoPath,
    }),
    handler: async (_input, ctx) => {
      await ctx.store.appendAudit(
        ctx.session.id,
        makeAuditEvent(ctx.session.id, "publish.requested", {}),
      );
      return { requested: true as const };
    },
  });

  host.register({
    name: "review.revise",
    description: "Record a revision request note before publish",
    effect: { effectClass: "write.draft" },
    input: z.object({
      note: z.string().min(1),
    }),
    output: z.object({
      revised: z.literal(true),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      await ctx.store.appendAudit(
        ctx.session.id,
        makeAuditEvent(ctx.session.id, "review.revised", { note: input.note }),
      );
      return { revised: true as const };
    },
  });

  host.register({
    name: "review.reject",
    description: "Reject publish intent with a reason",
    effect: { effectClass: "write.draft" },
    input: z.object({
      reason: z.string().min(1),
    }),
    output: z.object({
      rejected: z.literal(true),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      await ctx.store.appendAudit(
        ctx.session.id,
        makeAuditEvent(ctx.session.id, "publish.rejected", { reason: input.reason }),
      );
      return { rejected: true as const };
    },
  });

  host.register({
    name: "review.discard",
    description: "Discard all draft changes or selected paths",
    effect: { effectClass: "write.draft" },
    input: z.object({
      paths: z.array(z.string()).optional(),
    }),
    output: z.object({
      discarded: z.literal(true),
    }),
    resolveTarget: (_input, session) => ({
      kind: "session" as const,
      id: session.id,
    }),
    handler: async (input, ctx) => {
      ctx.overlay.reset(input.paths);
      await ctx.persistWorkspace();
      await ctx.store.appendAudit(
        ctx.session.id,
        makeAuditEvent(ctx.session.id, "review.discarded", {
          paths: input.paths ?? null,
        }),
      );
      return { discarded: true as const };
    },
  });

  host.register({
    name: "publish.apply",
    description: "Publish overlay changes into the repository after approval",
    effect: { effectClass: "publish.repo", requiresApprovalByDefault: true },
    input: z.object({
      resetOverlay: z.boolean().default(true),
    }),
    output: z.object({
      published: z.literal(true),
      changeCount: z.number().int().nonnegative(),
      paths: z.array(z.string()),
    }),
    resolveTarget: (_input, session) => ({
      kind: "repo_path" as const,
      id: "repo",
      path: session.repoPath,
    }),
    handler: async (input, ctx) => {
      const changes = await ctx.overlay.listChangesResolved();
      for (const change of changes) {
        const abs = resolveUnderRepo(ctx.session.repoPath, change.path);
        if (change.kind === "delete") {
          await fs.rm(abs, { force: true });
          await pruneEmptyParentDirs(ctx.session.repoPath, abs);
          continue;
        }
        if (change.content === undefined) {
          continue;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, change.content, "utf8");
      }

      if (input.resetOverlay ?? true) {
        ctx.overlay.reset();
        await ctx.persistWorkspace();
      }

      await ctx.store.appendAudit(
        ctx.session.id,
        makeAuditEvent(ctx.session.id, "publish.applied", {
          changeCount: changes.length,
          paths: changes.map((c) => c.path),
        }),
      );

      return {
        published: true as const,
        changeCount: changes.length,
        paths: changes.map((c) => c.path),
      };
    },
  });

  return host
    .listDescriptors()
    .filter((item) => !before.has(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countPrefixedLines(
  hunks: Array<{ lines: string[] }>,
  prefix: "+" | "-",
): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
        total += 1;
      }
    }
  }
  return total;
}

function countDiffLines(
  files: Array<{ hunks: Array<{ lines: string[] }> }>,
  prefix: "+" | "-",
): number {
  let total = 0;
  for (const file of files) {
    total += countPrefixedLines(file.hunks, prefix);
  }
  return total;
}
