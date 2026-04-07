#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApprovalGrant } from "@openharbor/pi-integration";
import { PiHarborBridge } from "@openharbor/pi-integration";

interface ParsedArgs {
  _: string[];
  options: Record<string, string | boolean | string[]>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed._;

  if (!command || command === "help" || parsed.options.help) {
    printHelp();
    return;
  }

  const dataDir = getStringOption(parsed.options, "data-dir");
  const bridge = new PiHarborBridge({ dataDir });

  switch (command) {
    case "init":
      await cmdInit(bridge, rest, parsed.options);
      return;
    case "caps":
      cmdCaps(bridge);
      return;
    case "call":
      await cmdCall(bridge, rest, parsed.options);
      return;
    case "read":
      await cmdRead(bridge, rest, parsed.options);
      return;
    case "write":
      await cmdWrite(bridge, rest, parsed.options);
      return;
    case "delete":
      await cmdDelete(bridge, rest, parsed.options);
      return;
    case "changes":
      await cmdChanges(bridge, rest);
      return;
    case "diff":
      await cmdDiff(bridge, rest);
      return;
    case "test":
      await cmdTest(bridge, rest, parsed.options);
      return;
    case "run":
      await cmdRun(bridge, rest, parsed.options);
      return;
    case "review":
      await cmdReview(bridge, rest);
      return;
    case "discard":
      await cmdDiscard(bridge, rest);
      return;
    case "reject":
      await cmdReject(bridge, rest, parsed.options);
      return;
    case "revise":
      await cmdRevise(bridge, rest, parsed.options);
      return;
    case "publish":
      await cmdPublish(bridge, rest, parsed.options);
      return;
    case "pi":
      await cmdPi(rest, parsed.options);
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

async function cmdInit(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const repoPath = args[0];
  if (!repoPath) {
    fail("Usage: harbor init <repo-path> [--name <name>]");
  }
  const name = getStringOption(options, "name");
  const session = await bridge.createSession(path.resolve(repoPath), name);
  printJson({ ok: true, session });
}

function cmdCaps(bridge: PiHarborBridge): void {
  printJson({ capabilities: bridge.listCapabilities() });
}

async function cmdCall(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const capability = args[1];
  if (!sessionId || !capability) {
    fail("Usage: harbor call <session-id> <capability> [--input '<json>'] [--grant <effectClass[:targetId]>]");
  }

  const inputRaw = getStringOption(options, "input");
  const input = inputRaw ? JSON.parse(inputRaw) : {};
  const grants = parseGrants(getStringArrayOption(options, "grant"));

  const result = await bridge.invoke({
    sessionId,
    capability,
    input,
    approvalGrants: grants,
    taskId: getStringOption(options, "task-id"),
  });
  printResult(result);
}

async function cmdRead(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const filePath = args[1];
  if (!sessionId || !filePath) {
    fail("Usage: harbor read <session-id> <path> [--repo]");
  }

  const capability = options.repo ? "repo.readFile" : "workspace.readFile";
  const result = await bridge.invoke({
    sessionId,
    capability,
    input: { path: filePath },
  });
  printResult(result);
}

async function cmdWrite(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const filePath = args[1];
  if (!sessionId || !filePath) {
    fail("Usage: harbor write <session-id> <path> --content '<text>'");
  }

  const content = getStringOption(options, "content");
  if (content === undefined) {
    fail("--content is required for harbor write");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.writeFile",
    input: { path: filePath, content },
  });
  printResult(result);
}

async function cmdDelete(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const targetPath = args[1];
  if (!sessionId || !targetPath) {
    fail("Usage: harbor delete <session-id> <path> [--file]");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.deletePath",
    input: {
      path: targetPath,
      recursive: !options.file,
    },
  });
  printResult(result);
}

async function cmdChanges(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor changes <session-id>");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.listChanges",
    input: {},
  });
  printResult(result);
}

async function cmdDiff(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor diff <session-id>");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.diff",
    input: {},
  });
  printResult(result);
}

async function cmdTest(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const adapter = args[1];
  if (!sessionId || !adapter) {
    fail("Usage: harbor test <session-id> <adapter> [--timeout-ms <ms>] [--approve]");
  }

  const grants: ApprovalGrant[] = [];
  if (options.approve) {
    grants.push(bridge.makeApprovalGrant("execute.adapter", adapter));
  }

  const timeoutRaw = getStringOption(options, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  const result = await bridge.invoke({
    sessionId,
    capability: "tests.run",
    input: {
      adapter,
      timeoutMs,
    },
    approvalGrants: grants,
  });
  printResult(result);
}

async function cmdRun(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor run <session-id> [--code '<js>'] [--file <path>] [--timeout-ms <ms>] [--approve-publish] [--approve-adapter <name>]");
  }

  const code = await loadCodeFromFlags(options);
  if (!code) {
    fail("Either --code or --file is required for harbor run");
  }

  const grants: ApprovalGrant[] = [];
  if (options["approve-publish"]) {
    grants.push(bridge.makeApprovalGrant("publish.repo", "repo"));
  }
  for (const adapterName of getStringArrayOption(options, "approve-adapter")) {
    if (adapterName.trim().length > 0) {
      grants.push(bridge.makeApprovalGrant("execute.adapter", adapterName.trim()));
    }
  }

  const timeoutRaw = getStringOption(options, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  const taskId = getStringOption(options, "task-id");

  const result = await bridge.runModelTask(sessionId, code, {
    taskId,
    limits: timeoutMs ? { timeoutMs } : undefined,
    approvalGrants: grants.length > 0 ? grants : undefined,
  });
  printResult(result);
}

async function cmdReview(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor review <session-id>");
  }

  const preview = await bridge.invoke({
    sessionId,
    capability: "publish.preview",
    input: {},
  });
  const diff = await bridge.invoke({
    sessionId,
    capability: "workspace.diff",
    input: {},
  });
  const changes = await bridge.invoke({
    sessionId,
    capability: "workspace.listChanges",
    input: {},
  });
  const testRuns = await bridge.invoke({
    sessionId,
    capability: "tests.listRuns",
    input: { limit: 1 },
  });

  if (preview.status !== "ok" || diff.status !== "ok" || changes.status !== "ok" || testRuns.status !== "ok") {
    printJson({ preview, diff, changes, testRuns });
    return;
  }

  printReviewBundle(preview.value, changes.value, diff.value, testRuns.value);
}

async function cmdDiscard(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor discard <session-id> [paths...]");
  }

  const paths = args.slice(1);
  const result = await bridge.invoke({
    sessionId,
    capability: "review.discard",
    input: paths.length > 0 ? { paths } : {},
  });
  printResult(result);
}

async function cmdReject(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor reject <session-id> --reason '<text>'");
  }
  const reason = getStringOption(options, "reason");
  if (!reason) {
    fail("--reason is required for harbor reject");
  }
  const result = await bridge.invoke({
    sessionId,
    capability: "review.reject",
    input: { reason },
  });
  printResult(result);
}

async function cmdRevise(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor revise <session-id> --note '<text>'");
  }
  const note = getStringOption(options, "note");
  if (!note) {
    fail("--note is required for harbor revise");
  }
  const result = await bridge.invoke({
    sessionId,
    capability: "review.revise",
    input: { note },
  });
  printResult(result);
}

async function cmdPublish(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    fail("Usage: harbor publish <session-id> [--approve] [--yes]");
  }

  const preview = await bridge.invoke({
    sessionId,
    capability: "publish.preview",
    input: {},
  });
  if (preview.status !== "ok") {
    printResult(preview);
    process.exitCode = 1;
    return;
  }

  printJson({ publishPreview: preview.value });

  if (!options.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Apply these overlay changes to the repo? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.error("Publish aborted.");
      return;
    }
  }

  const grants: ApprovalGrant[] = [];
  if (options.approve) {
    grants.push(bridge.makeApprovalGrant("publish.repo", "repo"));
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "publish.apply",
    input: {},
    approvalGrants: grants,
  });
  printResult(result);
}

async function cmdPi(
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const launchCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();

  let repoPath = getStringOption(options, "repo");
  const passthrough = [...args];
  if (!repoPath && passthrough.length > 0 && !passthrough[0]?.startsWith("--")) {
    repoPath = passthrough.shift();
  }

  const resolvedRepo = path.resolve(launchCwd, repoPath ?? ".");
  const extensionPath = path.resolve(cliDir, "pi-extension.js");
  const dataDir = getStringOption(options, "data-dir")
    ?? path.join(resolvedRepo, ".harbor-data");
  const approvedAdapters = getStringOption(options, "approved-adapters") ?? "pnpm-test";

  const piArgs: string[] = [];
  if (!options["keep-default-tools"]) {
    piArgs.push("--no-tools");
  }
  piArgs.push(
    "--extension",
    extensionPath,
    "--harbor-repo-path",
    resolvedRepo,
    "--harbor-data-dir",
    dataDir,
    "--harbor-approved-adapters",
    approvedAdapters,
    ...passthrough,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pi", piArgs, {
      stdio: "inherit",
      cwd: resolvedRepo,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`pi exited with signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`pi exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], options: {} };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }

    const raw = token.slice(2);
    const [key, inlineValue] = raw.split("=", 2);
    if (inlineValue !== undefined) {
      pushOption(out.options, key, inlineValue);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      pushOption(out.options, key, true);
      continue;
    }

    pushOption(out.options, key, next);
    i += 1;
  }

  return out;
}

function pushOption(
  store: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const current = store[key];
  if (current === undefined) {
    store[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(String(value));
    return;
  }
  store[key] = [String(current), String(value)];
}

function getStringOption(
  options: Record<string, string | boolean | string[]>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined || value === true || value === false) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return String(value);
}

function getStringArrayOption(
  options: Record<string, string | boolean | string[]>,
  key: string,
): string[] {
  const value = options[key];
  if (value === undefined || value === true || value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [String(value)];
}

function parseGrants(values: string[]): ApprovalGrant[] {
  const grants: ApprovalGrant[] = [];
  for (const value of values) {
    const [effectClass, targetId] = value.split(":", 2);
    if (!effectClass) {
      continue;
    }
    grants.push({
      scope: "once",
      effectClass: effectClass as ApprovalGrant["effectClass"],
      targetId,
    });
  }
  return grants;
}

async function loadCodeFromFlags(
  options: Record<string, string | boolean | string[]>,
): Promise<string | undefined> {
  const inlineCode = getStringOption(options, "code");
  if (inlineCode) {
    return inlineCode;
  }
  const filePath = getStringOption(options, "file");
  if (!filePath) {
    return undefined;
  }
  const fs = await import("node:fs/promises");
  const abs = path.resolve(filePath);
  return await fs.readFile(abs, "utf8");
}

function printResult(result: unknown): void {
  printJson(result);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(
    [
      "Harbor CLI",
      "",
      "Commands:",
      "  harbor init <repo-path> [--name <name>] [--data-dir <dir>]",
      "  harbor caps [--data-dir <dir>]",
      "  harbor call <session-id> <capability> [--input '<json>'] [--grant <effectClass[:targetId]>]",
      "  harbor read <session-id> <path> [--repo]",
      "  harbor write <session-id> <path> --content '<text>'",
      "  harbor delete <session-id> <path> [--file]",
      "  harbor changes <session-id>",
      "  harbor diff <session-id>",
      "  harbor test <session-id> <adapter> [--timeout-ms <ms>] [--approve]",
      "  harbor run <session-id> [--code '<js>'] [--file <path>] [--timeout-ms <ms>] [--approve-publish] [--approve-adapter <name>]",
      "  harbor review <session-id>",
      "  harbor discard <session-id> [paths...]",
      "  harbor reject <session-id> --reason '<text>'",
      "  harbor revise <session-id> --note '<text>'",
      "  harbor publish <session-id> [--approve] [--yes]",
      "  harbor pi [repo-path] [--repo <path>] [--data-dir <dir>] [--approved-adapters <csv>] [--keep-default-tools] [-- <pi args>]",
    ].join("\n") + "\n",
  );
}

function printReviewBundle(
  previewValue: unknown,
  changesValue: unknown,
  diffValue: unknown,
  testRunsValue: unknown,
): void {
  const preview = toRecord(previewValue);
  const changeCount = typeof preview.changeCount === "number" ? preview.changeCount : 0;
  process.stdout.write(`Task Summary: Prepared ${changeCount} draft change(s) for review.\n`);

  process.stdout.write("\nChanged Files:\n");
  const changesObj = toRecord(changesValue);
  const rawChanges = Array.isArray(changesObj.changes) ? changesObj.changes : [];
  if (rawChanges.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const item of rawChanges) {
      const row = toRecord(item);
      const pathValue = typeof row.path === "string" ? row.path : "<unknown>";
      const kindValue = typeof row.kind === "string" ? row.kind : "modify";
      process.stdout.write(`  - ${kindValue}: ${pathValue}\n`);
    }
  }

  process.stdout.write("\nDiff:\n");
  const diffObj = toRecord(diffValue);
  const files = Array.isArray(diffObj.files) ? diffObj.files : [];
  if (files.length === 0) {
    process.stdout.write("  (no diff)\n");
  } else {
    for (const file of files) {
      const fileObj = toRecord(file);
      const filePath = typeof fileObj.path === "string" ? fileObj.path : "<unknown>";
      process.stdout.write(`  ${filePath}\n`);
      const hunks = Array.isArray(fileObj.hunks) ? fileObj.hunks : [];
      for (const hunk of hunks) {
        const hunkObj = toRecord(hunk);
        const lines = Array.isArray(hunkObj.lines) ? hunkObj.lines : [];
        for (const line of lines) {
          if (typeof line === "string") {
            process.stdout.write(`    ${line}\n`);
          }
        }
      }
    }
  }

  process.stdout.write("\nTest Summary:\n");
  const testRunsObj = toRecord(testRunsValue);
  const runs = Array.isArray(testRunsObj.runs) ? testRunsObj.runs : [];
  if (runs.length === 0) {
    process.stdout.write("  No test run recorded in this session.\n");
  } else {
    const latest = toRecord(runs[0]);
    const adapter = typeof latest.adapter === "string" ? latest.adapter : "<unknown>";
    const ok = latest.ok === true;
    process.stdout.write(`  Latest run: ${adapter} (${ok ? "ok" : "failed"})\n`);
    if (typeof latest.stdoutArtifactId === "string") {
      process.stdout.write(`  stdout artifact: ${latest.stdoutArtifactId}\n`);
    }
    if (typeof latest.stderrArtifactId === "string") {
      process.stdout.write(`  stderr artifact: ${latest.stderrArtifactId}\n`);
    }
  }

  const paths = Array.isArray(preview.paths) ? preview.paths.filter((p) => typeof p === "string") : [];
  process.stdout.write("\nPublish Intent:\n");
  process.stdout.write(`  Publish ${changeCount} file change(s) to repo`);
  if (paths.length > 0) {
    process.stdout.write(`: ${paths.join(", ")}`);
  }
  process.stdout.write("\n");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
