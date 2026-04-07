import vm from "node:vm";

export interface TestSandboxOptions {
  /** Merged into the isolated context. Do not pass `require`, `fs`, or `process` unless you intend to widen trust. */
  globals?: Record<string, unknown>;
  /** Wall-clock timeout for script evaluation (default 2000ms). */
  timeoutMs?: number;
  /** Optional filename for stack traces */
  filename?: string;
}

const SAFE_CONSOLE = {
  log: (...args: unknown[]) => {
    console.log("[sandbox]", ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn("[sandbox]", ...args);
  },
};

/**
 * Evaluate a single JavaScript expression inside an isolated VM context.
 * Suitable for small, synchronous test snippets (no top-level await).
 */
export function evalInTestSandbox<T = unknown>(
  expression: string,
  options: TestSandboxOptions = {},
): T {
  const { globals = {}, timeoutMs = 2_000, filename = "eval-sandbox.js" } = options;
  const code = `"use strict"; (${expression})`;
  const context = vm.createContext({
    console: SAFE_CONSOLE,
    ...globals,
  });
  const script = new vm.Script(code, { filename });
  return script.runInContext(context, { timeout: timeoutMs }) as T;
}

/**
 * Run a script body (statements) in an isolated VM context. Return the value of the last expression
 * by assigning to `__result` in the script string, then reading it back (pattern not enforced here).
 *
 * Prefer {@link evalInTestSandbox} for simple expressions.
 */
export function runInTestSandbox<T = unknown>(
  scriptBody: string,
  options: TestSandboxOptions = {},
): T {
  const { globals = {}, timeoutMs = 2_000, filename = "run-sandbox.js" } = options;
  const wrapped = `"use strict";\n${scriptBody}`;
  const context = vm.createContext({
    console: SAFE_CONSOLE,
    ...globals,
  });
  const script = new vm.Script(wrapped, { filename });
  return script.runInContext(context, { timeout: timeoutMs }) as T;
}
