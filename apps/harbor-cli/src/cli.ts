#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  PiHarborBridge,
  resolvePolicyPreset,
  type ApprovalGrant,
} from "@openharbor/pi-integration";

interface ParsedArgs {
  _: string[];
  options: Record<string, string | boolean | string[]>;
}

type CliErrorCategory =
  | "usage_error"
  | "validation_error"
  | "approval_required"
  | "policy_denied"
  | "capability_error"
  | "runtime_error"
  | "internal_error";

class CliError extends Error {
  readonly name = "CliError";
  constructor(
    message: string,
    readonly category: CliErrorCategory,
    readonly errorCode: string,
    readonly nextAction?: string,
  ) {
    super(message);
  }
}

const COMMAND_USAGE = {
  init: "harbor init <repo-path> [--name <name>] [--data-dir <dir>] [--policy-preset <name>]",
  caps: "harbor caps [--data-dir <dir>] [--policy-preset <name>]",
  call: "harbor call <session-id> <capability> [--input '<json>'] [--grant <effectClass[:targetId]>] [--approve-scope <once|task|session>] [--task-id <id>] [--policy-preset <name>]",
  read: "harbor read <session-id> <path> [--repo] [--policy-preset <name>]",
  write: "harbor write <session-id> <path> --content '<text>' [--policy-preset <name>]",
  delete: "harbor delete <session-id> <path> [--file] [--policy-preset <name>]",
  changes: "harbor changes <session-id> [--policy-preset <name>]",
  diff: "harbor diff <session-id> [--policy-preset <name>]",
  test: "harbor test <session-id> <adapter> [--timeout-ms <ms>] [--approve] [--approve-scope <once|task|session>] [--task-id <id>] [--policy-preset <name>]",
  run: "harbor run <session-id> [--code '<js>'] [--file <path>] [--timeout-ms <ms>] [--approve-publish] [--approve-adapter <name>] [--approve-scope <once|task|session>] [--task-id <id>] [--policy-preset <name>]",
  review: "harbor review <session-id> [--json] [--verbose] [--policy-preset <name>]",
  discard: "harbor discard <session-id> [paths...] [--policy-preset <name>]",
  reject: "harbor reject <session-id> --reason '<text>' [--policy-preset <name>]",
  revise: "harbor revise <session-id> --note '<text>' [--policy-preset <name>]",
  publish: "harbor publish <session-id> [--approve] [--approve-scope <once|task|session>] [--task-id <id>] [--yes] [--policy-preset <name>]",
  approvals: "harbor approvals <list|revoke> <session-id> [flags]",
  audit: "harbor audit <inspect|search|replay> <session-id> [flags]",
  auditSearch: "harbor audit search <session-id> --query <text> [--limit N] [--type <eventType>]",
  pi: "harbor pi [repo-path] [--repo <path>] [--data-dir <dir>] [--approved-adapters <csv>] [--policy-preset <name>] [--keep-default-tools] [-- <pi args>]",
} as const;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, ...rest] = parsed._;

  if (!command || command === "help" || parsed.options.help) {
    printHelp();
    return;
  }

  const dataDir = getStringOption(parsed.options, "data-dir");
  const policyPreset = getPolicyPresetOption(parsed.options);
  const bridge = new PiHarborBridge({ dataDir, policyPreset });

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
      await cmdReview(bridge, rest, parsed.options);
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
    case "approvals":
      await cmdApprovals(bridge, rest, parsed.options);
      return;
    case "audit":
      await cmdAudit(bridge, rest, parsed.options);
      return;
    case "pi":
      await cmdPi(rest, parsed.options);
      return;
    default:
      fail(
        `Unknown command: ${command}`,
        "usage_error",
        "cli.command.unknown",
        "Run `harbor help` to see valid commands.",
      );
  }
}

async function cmdInit(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const repoPath = args[0];
  if (!repoPath) {
    failUsage("init");
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
    failUsage("call");
  }

  const inputRaw = getStringOption(options, "input");
  const input = inputRaw ? JSON.parse(inputRaw) : {};
  const grants = parseGrants(getStringArrayOption(options, "grant"));
  const scope = getApprovalScopeOption(options);
  if (scope === "task" && !getStringOption(options, "task-id")) {
    failTaskIdRequired();
  }
  for (const grant of grants) {
    grant.scope = scope;
  }

  const result = await bridge.invoke({
    sessionId,
    capability,
    input,
    approvalGrants: grants,
    taskId: getStringOption(options, "task-id"),
  });
  printResult(result, "call");
}

async function cmdRead(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const filePath = args[1];
  if (!sessionId || !filePath) {
    failUsage("read");
  }

  const capability = options.repo ? "repo.readFile" : "workspace.readFile";
  const result = await bridge.invoke({
    sessionId,
    capability,
    input: { path: filePath },
  });
  printResult(result, "read");
}

async function cmdWrite(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const filePath = args[1];
  if (!sessionId || !filePath) {
    failUsage("write");
  }

  const content = getStringOption(options, "content");
  if (content === undefined) {
    fail(
      "--content is required for harbor write",
      "usage_error",
      "cli.option.required.content",
      "Provide --content '<text>' with your draft changes.",
    );
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.writeFile",
    input: { path: filePath, content },
  });
  printResult(result, "write");
}

async function cmdDelete(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const targetPath = args[1];
  if (!sessionId || !targetPath) {
    failUsage("delete");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.deletePath",
    input: {
      path: targetPath,
      recursive: !options.file,
    },
  });
  printResult(result, "delete");
}

async function cmdChanges(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("changes");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.listChanges",
    input: {},
  });
  printResult(result, "changes");
}

async function cmdDiff(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("diff");
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "workspace.diff",
    input: {},
  });
  printResult(result, "diff");
}

async function cmdTest(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  const adapter = args[1];
  if (!sessionId || !adapter) {
    failUsage("test");
  }

  const grants: ApprovalGrant[] = [];
  const scope = getApprovalScopeOption(options);
  const taskId = getStringOption(options, "task-id");
  if (scope === "task" && !taskId) {
    failTaskIdRequired();
  }
  if (options.approve) {
    grants.push(bridge.makeApprovalGrant("execute.adapter", adapter, scope));
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
    taskId,
  });
  printResult(result, "test");
}

async function cmdRun(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("run");
  }

  const code = await loadCodeFromFlags(options);
  if (!code) {
    fail(
      "Either --code or --file is required for harbor run",
      "usage_error",
      "cli.option.required.code_or_file",
      "Pass --code '<js>' for inline code or --file <path> for a script.",
    );
  }

  const grants: ApprovalGrant[] = [];
  const scope = getApprovalScopeOption(options);
  const taskId = getStringOption(options, "task-id");
  if (scope === "task" && !taskId) {
    failTaskIdRequired();
  }
  if (options["approve-publish"]) {
    grants.push(bridge.makeApprovalGrant("publish.repo", "repo", scope));
  }
  for (const adapterName of getStringArrayOption(options, "approve-adapter")) {
    if (adapterName.trim().length > 0) {
      grants.push(bridge.makeApprovalGrant("execute.adapter", adapterName.trim(), scope));
    }
  }

  const timeoutRaw = getStringOption(options, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  const result = await bridge.runModelTask(sessionId, code, {
    taskId,
    limits: timeoutMs ? { timeoutMs } : undefined,
    approvalGrants: grants.length > 0 ? grants : undefined,
  });
  printResult(result, "run");
}

async function cmdReview(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("review");
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
    printResult(
      {
        status: "internal_error",
        message: "Unable to build review bundle from one or more capability calls.",
        category: "internal_error",
        errorCode: "cli.review.bundle_failed",
        nextAction: "Run `harbor changes <session-id>` and `harbor diff <session-id>` individually, then retry review.",
        reviewCalls: { preview, diff, changes, testRuns },
      },
      "review",
    );
    process.exitCode = 1;
    return;
  }

  const bundle = buildReviewBundle(preview.value, changes.value, diff.value, testRuns.value);
  if (options.json) {
    printJson(bundle);
    return;
  }
  printReviewBundle(bundle, options.verbose === true);
}

async function cmdDiscard(bridge: PiHarborBridge, args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("discard");
  }

  const paths = args.slice(1);
  const result = await bridge.invoke({
    sessionId,
    capability: "review.discard",
    input: paths.length > 0 ? { paths } : {},
  });
  printResult(result, "discard");
}

async function cmdReject(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("reject");
  }
  const reason = getStringOption(options, "reason");
  if (!reason) {
    fail(
      "--reason is required for harbor reject",
      "usage_error",
      "cli.option.required.reason",
      "Provide --reason '<text>' so the model can revise based on feedback.",
    );
  }
  const result = await bridge.invoke({
    sessionId,
    capability: "review.reject",
    input: { reason },
  });
  printResult(result, "reject");
}

async function cmdRevise(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("revise");
  }
  const note = getStringOption(options, "note");
  if (!note) {
    fail(
      "--note is required for harbor revise",
      "usage_error",
      "cli.option.required.note",
      "Provide --note '<text>' to guide the next draft revision.",
    );
  }
  const result = await bridge.invoke({
    sessionId,
    capability: "review.revise",
    input: { note },
  });
  printResult(result, "revise");
}

async function cmdPublish(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    failUsage("publish");
  }

  const preview = await bridge.invoke({
    sessionId,
    capability: "publish.preview",
    input: {},
  });
  if (preview.status !== "ok") {
    printResult(preview, "publish");
    process.exitCode = 1;
    return;
  }

  process.stdout.write("Publish Intent:\n");
  process.stdout.write("  Apply reviewed draft changes from the overlay into the repository.\n");
  process.stdout.write("Next: confirm to continue publish, or run `harbor review <session-id>` first.\n");
  printJson({ publishPreview: preview.value });

  if (!options.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Apply these overlay changes to the repo? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      const aborted = {
        status: "denied",
        message: "Publish aborted.",
        category: "policy_denied",
        errorCode: "publish.aborted",
        reason: "Operator cancelled publish confirmation.",
        nextAction: "Run `harbor review <session-id>` to inspect the draft, then retry `harbor publish <session-id>` when ready.",
      };
      printResult(aborted, "publish");
      return;
    }
  }

  const grants: ApprovalGrant[] = [];
  const scope = getApprovalScopeOption(options);
  const taskId = getStringOption(options, "task-id");
  if (scope === "task" && !taskId) {
    failTaskIdRequired();
  }
  if (options.approve) {
    grants.push(bridge.makeApprovalGrant("publish.repo", "repo", scope));
  }

  const result = await bridge.invoke({
    sessionId,
    capability: "publish.apply",
    input: {},
    approvalGrants: grants,
    taskId,
  });
  printResult(result, "publish");
}

async function cmdApprovals(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const action = args[0];
  const sessionId = args[1];
  if (!action || !sessionId) {
    failUsage("approvals");
  }

  if (action === "list") {
    const result = await bridge.invoke({
      sessionId,
      capability: "approvals.list",
      input: {
        includeInactive: options["include-inactive"] !== false,
      },
    });
    printResult(result, "approvals");
    return;
  }

  if (action === "revoke") {
    const grantId = getStringOption(options, "grant-id");
    const taskId = getStringOption(options, "task-id");
    const all = options.all === true;
    const selectorCount = [grantId ? 1 : 0, taskId ? 1 : 0, all ? 1 : 0].reduce(
      (sum, item) => sum + item,
      0,
    );
    if (selectorCount !== 1) {
      fail(
        "Provide exactly one revocation selector: --grant-id, --task-id, or --all",
        "usage_error",
        "approvals.revoke.selector_invalid",
        "Pick one selector only: --grant-id <id>, --task-id <id>, or --all.",
      );
    }

    const result = await bridge.invoke({
      sessionId,
      capability: "approvals.revoke",
      input: {
        grantId,
        taskId,
        all,
        reason: getStringOption(options, "reason"),
      },
    });
    printResult(result, "approvals");
    return;
  }

  fail(
    `Unknown approvals action: ${action}`,
    "usage_error",
    "approvals.action.unknown",
    "Use `harbor approvals list <session-id>` or `harbor approvals revoke <session-id> ...`.",
  );
}

async function cmdAudit(
  bridge: PiHarborBridge,
  args: string[],
  options: Record<string, string | boolean | string[]>,
): Promise<void> {
  const action = args[0];
  const sessionId = args[1];
  if (!action || !sessionId) {
    failUsage("audit");
  }

  await bridge.env.sessions.getBundle(sessionId);

  if (action === "inspect") {
    const filtered = await queryAuditEvents(bridge, sessionId, options);
    const includeVerify = options.verify === true;
    const integrity = includeVerify ? await bridge.env.store.verifyAuditIntegrity(sessionId) : undefined;
    printJson({
      sessionId,
      totalEvents: filtered.totalEvents,
      returnedEvents: filtered.events.length,
      filters: filtered.filters,
      events: filtered.events,
      integrity,
    });
    return;
  }

  if (action === "search") {
    const query = getStringOption(options, "query");
    if (!query) {
      failUsage("auditSearch");
    }
    const filtered = await queryAuditEvents(bridge, sessionId, options);
    const needle = query.toLowerCase();
    const matches = filtered.events.filter((event) => {
      const eventObj = toRecord(event);
      const haystack = `${String(eventObj.type ?? "")} ${JSON.stringify(eventObj.payload ?? {})}`.toLowerCase();
      return haystack.includes(needle);
    });
    printJson({
      sessionId,
      query,
      totalEvents: filtered.totalEvents,
      searchedEvents: filtered.events.length,
      matchCount: matches.length,
      filters: filtered.filters,
      matches,
    });
    return;
  }

  if (action === "replay") {
    const allEvents = await bridge.env.store.readAudit(sessionId);
    const integrity = await bridge.env.store.verifyAuditIntegrity(sessionId);
    const timeline = buildReplayTimeline(allEvents);

    process.stdout.write(`Replay Summary (${sessionId.slice(0, 8)})\n`);
    process.stdout.write(`  events: ${allEvents.length}\n`);
    process.stdout.write(`  model runs: ${timeline.modelRuns.total}\n`);
    process.stdout.write(
      `  approvals: granted=${timeline.approvals.granted}, used=${timeline.approvals.used}, revoked=${timeline.approvals.revoked}\n`,
    );
    process.stdout.write(
      `  policy: denied=${timeline.policy.denied}, approval_required=${timeline.policy.requireApproval}\n`,
    );
    process.stdout.write(
      `  publish: requested=${timeline.publish.requested}, applied=${timeline.publish.applied}, rejected=${timeline.publish.rejected}\n`,
    );
    if (timeline.changes.paths.length > 0) {
      process.stdout.write(`  changed paths: ${timeline.changes.paths.join(", ")}\n`);
    }

    printJson({
      sessionId,
      integrity,
      timeline,
      events: allEvents,
    });
    return;
  }

  fail(
    `Unknown audit action: ${action}`,
    "usage_error",
    "audit.action.unknown",
    "Use one of: inspect, search, replay.",
  );
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
  const policyPreset = getPolicyPresetOption(options);

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
    "--harbor-policy-preset",
    policyPreset,
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

function getNumberOption(
  options: Record<string, string | boolean | string[]>,
  key: string,
): number | undefined {
  const raw = getStringOption(options, key);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    fail(
      `Option --${key} must be a number`,
      "validation_error",
      "cli.option.invalid_number",
      `Provide a numeric value for --${key}.`,
    );
  }
  return parsed;
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

function getApprovalScopeOption(
  options: Record<string, string | boolean | string[]>,
): ApprovalGrant["scope"] {
  const scope = (getStringOption(options, "approve-scope") ?? "once").trim().toLowerCase();
  if (scope === "once" || scope === "task" || scope === "session") {
    return scope;
  }
  fail(
    `Unknown --approve-scope value "${scope}". Expected once, task, or session.`,
    "validation_error",
    "cli.approval_scope.invalid",
    "Use --approve-scope once, --approve-scope task, or --approve-scope session.",
  );
}

function getPolicyPresetOption(
  options: Record<string, string | boolean | string[]>,
): ReturnType<typeof resolvePolicyPreset> {
  const raw = getStringOption(options, "policy-preset") ?? process.env.OPENHARBOR_POLICY_PRESET;
  return resolvePolicyPreset(raw);
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

type ResultCommand =
  | "call"
  | "read"
  | "write"
  | "delete"
  | "changes"
  | "diff"
  | "test"
  | "run"
  | "review"
  | "discard"
  | "reject"
  | "revise"
  | "publish"
  | "approvals";

function printResult(result: unknown, command?: ResultCommand): void {
  const normalized = normalizeResultTaxonomy(result, command);

  if (isRecord(normalized) && normalized.status === "ok") {
    const next = command ? defaultNextActionForSuccess(command) : undefined;
    if (next) {
      process.stdout.write(`Next: ${next}\n`);
    }
    if (command === "run") {
      const value = toRecord(normalized.value);
      if (value.ok === false) {
        process.stdout.write("Runtime execution failed.\n");
      }
    }
  }

  if (isRecord(normalized) && normalized.status === "approval_required") {
    const intent = typeof normalized.intent === "string" ? normalized.intent : "Approval required";
    const reason = typeof normalized.reason === "string" ? normalized.reason : undefined;
    const nextAction = typeof normalized.nextAction === "string" ? normalized.nextAction : undefined;
    process.stdout.write(`${intent}\n`);
    if (reason) {
      process.stdout.write(`Reason: ${reason}\n`);
    }
    if (nextAction) {
      process.stdout.write(`Next: ${nextAction}\n`);
    }
    if (typeof normalized.grantScopeHint === "string") {
      process.stdout.write(`Suggested scope: ${normalized.grantScopeHint}\n`);
    }
    if (typeof normalized.targetLabel === "string") {
      process.stdout.write(`Target: ${normalized.targetLabel}\n`);
    }
  }
  if (isRecord(normalized) && normalized.status === "denied") {
    process.stdout.write(`Denied: ${typeof normalized.message === "string" ? normalized.message : "policy denied"}\n`);
    if (typeof normalized.reason === "string") {
      process.stdout.write(`Reason: ${normalized.reason}\n`);
    }
    if (typeof normalized.nextAction === "string") {
      process.stdout.write(`Next: ${normalized.nextAction}\n`);
    }
  }
  if (isRecord(normalized) && normalized.status === "validation_error") {
    const message = typeof normalized.message === "string" ? normalized.message : "validation failed";
    process.stdout.write(`Validation: ${message}\n`);
    if (typeof normalized.nextAction === "string") {
      process.stdout.write(`Next: ${normalized.nextAction}\n`);
    }
  }
  printJson(normalized);
}

function normalizeResultTaxonomy(result: unknown, command?: ResultCommand): unknown {
  if (!isRecord(result)) {
    return result;
  }
  const out = { ...result } as Record<string, unknown>;
  if (typeof out.status !== "string") {
    return out;
  }

  if (out.status === "approval_required") {
    out.category ??= "approval_required";
    out.errorCode ??= "approval.required";
    out.nextAction ??= defaultNextActionForDeniedOrApproval(command);
  } else if (out.status === "denied") {
    out.category ??= "policy_denied";
    out.errorCode ??= "policy.denied";
    out.nextAction ??= defaultNextActionForDeniedOrApproval(command);
  } else if (out.status === "validation_error") {
    out.category ??= "validation_error";
    out.errorCode ??= "validation.failed";
    out.nextAction ??= defaultNextActionForValidation(command);
  }
  return out;
}

function defaultNextActionForSuccess(command: ResultCommand): string | undefined {
  if (command === "read") {
    return "Use `harbor write <session-id> <path> --content '<text>'` to draft a change, then run `harbor diff <session-id>`.";
  }
  if (command === "write" || command === "delete" || command === "discard" || command === "revise") {
    return "Run `harbor diff <session-id>` to inspect draft changes, then `harbor review <session-id>`.";
  }
  if (command === "diff" || command === "changes") {
    return "Run `harbor review <session-id>` for a full review bundle before publish.";
  }
  if (command === "test") {
    return "Run `harbor review <session-id>` to inspect latest test outcome before publish.";
  }
  if (command === "review") {
    return "If this draft looks good, run `harbor publish <session-id> --approve`.";
  }
  if (command === "publish") {
    return "Publish is complete. Continue with a new task or run `harbor review <session-id>` to confirm no pending draft.";
  }
  if (command === "run") {
    return "Run `harbor review <session-id>` to inspect generated draft changes, tests, and publish intent.";
  }
  if (command === "reject") {
    return "Run `harbor revise <session-id> --note '<guidance>'` to request the next draft.";
  }
  if (command === "approvals") {
    return "Use `harbor approvals list <session-id>` to verify active grant state.";
  }
  return undefined;
}

function defaultNextActionForDeniedOrApproval(command?: ResultCommand): string {
  if (command === "publish" || command === "review") {
    return "Run `harbor review <session-id>` to inspect intent, then retry with `--approve` and an optional scope.";
  }
  if (command === "test") {
    return "Retry with `--approve` and choose a scope (`once`, `task`, or `session`) if needed.";
  }
  return "Review policy intent and retry with explicit approval grant options.";
}

function defaultNextActionForValidation(command?: ResultCommand): string {
  if (command === "run") {
    return "Check `--code`/`--file` inputs and rerun `harbor run`.";
  }
  return "Check command usage with `harbor help` and retry.";
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  const commandLines = Object.values(COMMAND_USAGE).map((usage) => `  ${usage}`);
  process.stdout.write(
    [
      "Harbor CLI",
      "",
      "Commands:",
      ...commandLines,
      "",
      "Core Flow (inspect -> draft -> test -> review -> publish):",
      "  harbor init ./repo",
      "  harbor read <session-id> README.md --repo",
      "  harbor write <session-id> notes.txt --content 'draft change'",
      "  harbor test <session-id> pnpm-test --approve",
      "  harbor review <session-id>",
      "  harbor publish <session-id> --approve",
      "",
      "More Examples:",
      "  harbor review <session-id> --json",
      "  harbor review <session-id> --verbose",
      "  harbor run <session-id> --file task.js --approve-adapter pnpm-test --approve-publish",
      "  harbor approvals revoke <session-id> --task-id task-123 --reason 'task complete'",
      "  harbor audit replay <session-id>",
      "",
      "Policy presets: permissive, balanced, strict",
      "Approval scopes: once, task, session (via --approve-scope)",
      "Environment: OPENHARBOR_POLICY_PRESET=<name>",
    ].join("\n") + "\n",
  );
}

async function queryAuditEvents(
  bridge: PiHarborBridge,
  sessionId: string,
  options: Record<string, string | boolean | string[]>,
): Promise<{
  totalEvents: number;
  events: unknown[];
  filters: Record<string, unknown>;
}> {
  const all = await bridge.env.store.readAudit(sessionId);
  const typeFilter = getStringOption(options, "type");
  const fromIso = getStringOption(options, "from");
  const toIso = getStringOption(options, "to");
  const fromMs = fromIso ? parseIsoOrFail("from", fromIso) : undefined;
  const toMs = toIso ? parseIsoOrFail("to", toIso) : undefined;
  const limit = Math.max(1, Math.floor(getNumberOption(options, "limit") ?? 100));

  const filtered = all.filter((event) => {
    if (typeFilter && event.type !== typeFilter) {
      return false;
    }
    const ts = Date.parse(event.ts);
    if (fromMs !== undefined && Number.isFinite(ts) && ts < fromMs) {
      return false;
    }
    if (toMs !== undefined && Number.isFinite(ts) && ts > toMs) {
      return false;
    }
    return true;
  });

  const limited = filtered.slice(-limit);
  return {
    totalEvents: all.length,
    events: limited,
    filters: {
      type: typeFilter ?? null,
      from: fromIso ?? null,
      to: toIso ?? null,
      limit,
    },
  };
}

function parseIsoOrFail(name: "from" | "to", value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail(`Option --${name} must be an ISO timestamp`);
  }
  return parsed;
}

function buildReplayTimeline(
  events: unknown[],
): {
  modelRuns: { total: number; completed: number; failed: number };
  approvals: { granted: number; used: number; revoked: number };
  policy: { denied: number; requireApproval: number };
  publish: { requested: number; applied: number; rejected: number };
  capabilityCalls: Array<{ capabilityName: string; count: number }>;
  changes: { paths: string[] };
} {
  const capabilityCalls = new Map<string, number>();
  const changedPaths = new Set<string>();

  let modelRunStarted = 0;
  let modelRunCompleted = 0;
  let modelRunFailed = 0;
  let approvalGranted = 0;
  let approvalUsed = 0;
  let approvalRevoked = 0;
  let publishRequested = 0;
  let publishApplied = 0;
  let publishRejected = 0;
  let denied = 0;
  let requireApproval = 0;

  for (const rawEvent of events) {
    const event = toRecord(rawEvent);
    const type = typeof event.type === "string" ? event.type : "";
    const payload = toRecord(event.payload);

    if (type === "model_run.started") {
      modelRunStarted += 1;
    } else if (type === "model_run.completed") {
      modelRunCompleted += 1;
    } else if (type === "model_run.failed") {
      modelRunFailed += 1;
    } else if (type === "approval.granted") {
      approvalGranted += 1;
    } else if (type === "approval.used") {
      approvalUsed += 1;
    } else if (type === "approval.revoked") {
      approvalRevoked += 1;
    } else if (type === "publish.requested") {
      publishRequested += 1;
    } else if (type === "publish.applied") {
      publishApplied += 1;
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      for (const value of paths) {
        if (typeof value === "string") {
          changedPaths.add(value);
        }
      }
    } else if (type === "publish.rejected") {
      publishRejected += 1;
    } else if (type === "capability.call") {
      const name = typeof payload.capabilityName === "string" ? payload.capabilityName : "<unknown>";
      capabilityCalls.set(name, (capabilityCalls.get(name) ?? 0) + 1);
    } else if (type === "overlay.mutated") {
      const pathValue = typeof payload.path === "string" ? payload.path : null;
      if (pathValue) {
        changedPaths.add(pathValue);
      }
    } else if (type === "policy.evaluation") {
      const decision = typeof payload.decision === "string" ? payload.decision : "";
      if (decision === "deny") {
        denied += 1;
      } else if (decision === "require_approval") {
        requireApproval += 1;
      }
    }
  }

  return {
    modelRuns: {
      total: modelRunStarted,
      completed: modelRunCompleted,
      failed: modelRunFailed,
    },
    approvals: {
      granted: approvalGranted,
      used: approvalUsed,
      revoked: approvalRevoked,
    },
    policy: {
      denied,
      requireApproval,
    },
    publish: {
      requested: publishRequested,
      applied: publishApplied,
      rejected: publishRejected,
    },
    capabilityCalls: [...capabilityCalls.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([capabilityName, count]) => ({ capabilityName, count })),
    changes: {
      paths: [...changedPaths].sort(),
    },
  };
}

interface ReviewBundle {
  status: "ok";
  taskSummary: { changeCount: number };
  changedFiles: Array<{ path: string; kind: string }>;
  diffSummary: {
    fileCount: number;
    hunkCount: number;
    additions: number;
    deletions: number;
    files: Array<{ path: string; hunks: number; additions: number; deletions: number }>;
  };
  diffDetails: Array<{ path: string; hunks: Array<{ header: string; lines: string[] }> }>;
  testSummary:
    | { hasRun: false; message: string }
    | {
        hasRun: true;
        latest: {
          adapter: string;
          runId: string;
          ok: boolean;
          stdoutArtifactId?: string;
          stderrArtifactId?: string;
        };
      };
  publishIntent: {
    changeCount: number;
    paths: string[];
    message: string;
  };
  nextAction: string;
}

function buildReviewBundle(
  previewValue: unknown,
  changesValue: unknown,
  diffValue: unknown,
  testRunsValue: unknown,
): ReviewBundle {
  const preview = toRecord(previewValue);
  const changeCount = typeof preview.changeCount === "number" ? preview.changeCount : 0;
  const paths = Array.isArray(preview.paths) ? preview.paths.filter((p) => typeof p === "string") : [];

  const changesObj = toRecord(changesValue);
  const rawChanges = Array.isArray(changesObj.changes) ? changesObj.changes : [];
  const changedFiles = rawChanges.map((item) => {
    const row = toRecord(item);
    return {
      path: typeof row.path === "string" ? row.path : "<unknown>",
      kind: typeof row.kind === "string" ? row.kind : "modify",
    };
  });

  const diffObj = toRecord(diffValue);
  const files = Array.isArray(diffObj.files) ? diffObj.files : [];
  const diffDetails: ReviewBundle["diffDetails"] = [];
  let additionTotal = 0;
  let deletionTotal = 0;
  let hunkTotal = 0;
  const diffFiles: ReviewBundle["diffSummary"]["files"] = [];
  for (const rawFile of files) {
    const fileObj = toRecord(rawFile);
    const filePath = typeof fileObj.path === "string" ? fileObj.path : "<unknown>";
    const rawHunks = Array.isArray(fileObj.hunks) ? fileObj.hunks : [];
    const detailHunks: Array<{ header: string; lines: string[] }> = [];
    let fileAdditions = 0;
    let fileDeletions = 0;

    for (const rawHunk of rawHunks) {
      const hunkObj = toRecord(rawHunk);
      const lines = (Array.isArray(hunkObj.lines) ? hunkObj.lines : []).filter(
        (line): line is string => typeof line === "string",
      );
      const header = typeof hunkObj.header === "string" ? hunkObj.header : "@@";
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          fileAdditions += 1;
          additionTotal += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          fileDeletions += 1;
          deletionTotal += 1;
        }
      }
      detailHunks.push({ header, lines });
      hunkTotal += 1;
    }

    diffDetails.push({ path: filePath, hunks: detailHunks });
    diffFiles.push({
      path: filePath,
      hunks: detailHunks.length,
      additions: fileAdditions,
      deletions: fileDeletions,
    });
  }

  const testRunsObj = toRecord(testRunsValue);
  const runs = Array.isArray(testRunsObj.runs) ? testRunsObj.runs : [];
  const testSummary: ReviewBundle["testSummary"] = runs.length === 0
    ? {
        hasRun: false,
        message: "No test run recorded in this session.",
      }
    : (() => {
        const latest = toRecord(runs[0]);
        return {
          hasRun: true as const,
          latest: {
            adapter: typeof latest.adapter === "string" ? latest.adapter : "<unknown>",
            runId: typeof latest.runId === "string" ? latest.runId : "<unknown>",
            ok: latest.ok === true,
            stdoutArtifactId:
              typeof latest.stdoutArtifactId === "string" ? latest.stdoutArtifactId : undefined,
            stderrArtifactId:
              typeof latest.stderrArtifactId === "string" ? latest.stderrArtifactId : undefined,
          },
        };
      })();

  return {
    status: "ok",
    taskSummary: {
      changeCount,
    },
    changedFiles,
    diffSummary: {
      fileCount: diffFiles.length,
      hunkCount: hunkTotal,
      additions: additionTotal,
      deletions: deletionTotal,
      files: diffFiles,
    },
    diffDetails,
    testSummary,
    publishIntent: {
      changeCount,
      paths,
      message:
        paths.length > 0
          ? `Publish draft changes (${changeCount} file change(s)) to repository: ${paths.join(", ")}`
          : `Publish draft changes (${changeCount} file change(s)) to repository.`,
    },
    nextAction:
      changeCount > 0
        ? "If the review looks correct, run `harbor publish <session-id> --approve`."
        : "No draft changes are pending. Continue with `harbor write`/`harbor run` to create a draft.",
  };
}

function printReviewBundle(bundle: ReviewBundle, verbose: boolean): void {
  process.stdout.write(`Task Summary: Prepared ${bundle.taskSummary.changeCount} draft change(s) for review.\n`);

  process.stdout.write("\nChanged Files:\n");
  if (bundle.changedFiles.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const item of bundle.changedFiles) {
      process.stdout.write(`  - ${item.kind}: ${item.path}\n`);
    }
  }

  process.stdout.write("\nDiff Summary:\n");
  process.stdout.write(
    `  files=${bundle.diffSummary.fileCount}, hunks=${bundle.diffSummary.hunkCount}, +${bundle.diffSummary.additions}/-${bundle.diffSummary.deletions}\n`,
  );
  for (const file of bundle.diffSummary.files) {
    process.stdout.write(`  - ${file.path}: ${file.hunks} hunk(s), +${file.additions}/-${file.deletions}\n`);
  }

  if (verbose) {
    process.stdout.write("\nDiff Details:\n");
    if (bundle.diffDetails.length === 0) {
      process.stdout.write("  (no diff)\n");
    } else {
      for (const file of bundle.diffDetails) {
        process.stdout.write(`  ${file.path}\n`);
        for (const hunk of file.hunks) {
          process.stdout.write(`    ${hunk.header}\n`);
          for (const line of hunk.lines) {
            process.stdout.write(`    ${line}\n`);
          }
        }
      }
    }
  }

  process.stdout.write("\nTest Outcome:\n");
  if (!bundle.testSummary.hasRun) {
    process.stdout.write(`  ${bundle.testSummary.message}\n`);
  } else {
    const latest = bundle.testSummary.latest;
    process.stdout.write(`  Latest run: ${latest.adapter} (${latest.ok ? "ok" : "failed"})\n`);
    process.stdout.write(`  runId: ${latest.runId}\n`);
    if (latest.stdoutArtifactId) {
      process.stdout.write(`  stdout artifact: ${latest.stdoutArtifactId}\n`);
    }
    if (latest.stderrArtifactId) {
      process.stdout.write(`  stderr artifact: ${latest.stderrArtifactId}\n`);
    }
  }

  process.stdout.write("\nPublish Intent:\n");
  process.stdout.write(`  ${bundle.publishIntent.message}\n`);
  process.stdout.write(`Next: ${bundle.nextAction}\n`);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function failUsage(command: keyof typeof COMMAND_USAGE): never {
  fail(
    `Usage: ${COMMAND_USAGE[command]}`,
    "usage_error",
    "cli.usage.invalid",
    `Run \`${COMMAND_USAGE[command]}\`.`,
  );
}

function failTaskIdRequired(): never {
  fail(
    "--task-id is required when --approve-scope task is used",
    "validation_error",
    "approval.scope.task_id_required",
    "Add --task-id <id> or choose --approve-scope once/session.",
  );
}

function fail(
  message: string,
  category: CliErrorCategory = "usage_error",
  errorCode = "cli.usage.invalid",
  nextAction = "Run `harbor help` for command usage.",
): never {
  throw new CliError(message, category, errorCode, nextAction);
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`[${error.category}] ${error.message}\n`);
    if (error.nextAction) {
      process.stderr.write(`Next: ${error.nextAction}\n`);
    }
    printJson({
      status: "error",
      category: error.category,
      errorCode: error.errorCode,
      message: error.message,
      nextAction: error.nextAction,
    });
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[internal_error] ${message}\n`);
  printJson({
    status: "error",
    category: "internal_error",
    errorCode: "internal.unexpected",
    message,
    nextAction: "Retry the command. If this persists, capture logs and file an issue.",
  });
  process.exitCode = 1;
});
