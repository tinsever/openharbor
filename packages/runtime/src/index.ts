import vm from "node:vm";

export interface HarborRuntimeInvokeBridge {
  invoke: (capabilityName: string, input: unknown) => Promise<unknown>;
}

export interface HarborRuntimeLimits {
  timeoutMs?: number;
  maxCodeBytes?: number;
  maxOutputBytes?: number;
  maxHeapDeltaBytes?: number;
}

export interface HarborRuntimeExecuteInput {
  code: string;
  bridge: HarborRuntimeInvokeBridge;
  filename?: string;
  limits?: HarborRuntimeLimits;
}

export interface HarborRuntimeExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncatedOutput: boolean;
}

export interface HarborRuntime {
  execute: (input: HarborRuntimeExecuteInput) => Promise<HarborRuntimeExecutionResult>;
}

export interface HarborRuntimeOptions {
  defaults?: HarborRuntimeLimits;
}

const DEFAULT_LIMITS: Required<HarborRuntimeLimits> = {
  timeoutMs: 2_000,
  maxCodeBytes: 128 * 1024,
  maxOutputBytes: 256 * 1024,
  maxHeapDeltaBytes: 64 * 1024 * 1024,
};

export function createHarborRuntime(options: HarborRuntimeOptions = {}): HarborRuntime {
  const defaults = {
    timeoutMs: options.defaults?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxCodeBytes: options.defaults?.maxCodeBytes ?? DEFAULT_LIMITS.maxCodeBytes,
    maxOutputBytes: options.defaults?.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
    maxHeapDeltaBytes: options.defaults?.maxHeapDeltaBytes ?? DEFAULT_LIMITS.maxHeapDeltaBytes,
  };

  return {
    execute: async (input) => executeInHarborRuntime(input, defaults),
  };
}

async function executeInHarborRuntime(
  input: HarborRuntimeExecuteInput,
  defaults: Required<HarborRuntimeLimits>,
): Promise<HarborRuntimeExecutionResult> {
  const start = Date.now();
  const timeoutMs = input.limits?.timeoutMs ?? defaults.timeoutMs;
  const maxCodeBytes = input.limits?.maxCodeBytes ?? defaults.maxCodeBytes;
  const maxOutputBytes = input.limits?.maxOutputBytes ?? defaults.maxOutputBytes;
  const maxHeapDeltaBytes = input.limits?.maxHeapDeltaBytes ?? defaults.maxHeapDeltaBytes;
  const codeBytes = Buffer.byteLength(input.code, "utf8");
  if (codeBytes > maxCodeBytes) {
    return {
      ok: false,
      error: `Code size limit exceeded: ${codeBytes} > ${maxCodeBytes} bytes`,
      timedOut: false,
      durationMs: Date.now() - start,
      stdout: "",
      stderr: "",
      truncatedOutput: false,
    };
  }

  const output = createBoundedOutputCollector(maxOutputBytes);
  const context = vm.createContext({
    console: {
      log: (...args: unknown[]) => {
        output.stdout(formatConsoleArgs(args));
      },
      warn: (...args: unknown[]) => {
        output.stderr(formatConsoleArgs(args));
      },
      error: (...args: unknown[]) => {
        output.stderr(formatConsoleArgs(args));
      },
    },
    harbor: Object.freeze({
      invoke: async (capabilityName: string, capabilityInput: unknown) =>
        input.bridge.invoke(capabilityName, capabilityInput),
    }),
    // Explicitly remove common ambient authority paths.
    process: undefined,
    require: undefined,
    global: undefined,
    globalThis: undefined,
    module: undefined,
    exports: undefined,
    Buffer: undefined,
    setImmediate: undefined,
    setInterval: undefined,
    setTimeout: undefined,
    clearImmediate: undefined,
    clearInterval: undefined,
    clearTimeout: undefined,
    fetch: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    XMLHttpRequest: undefined,
  });

  const wrappedCode = [
    `"use strict";`,
    `(async () => {`,
    input.code,
    `})()`,
  ].join("\n");
  const memoryBefore = currentRuntimeMemoryBytes();

  try {
    const script = new vm.Script(wrappedCode, {
      filename: input.filename ?? "harbor-runtime.js",
    });

    const runPromise = Promise.resolve(script.runInContext(context, { timeout: timeoutMs }));
    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        reject(new Error("__HARBOR_RUNTIME_TIMEOUT__"));
      }, timeoutMs);
      id.unref();
    });

    const value = await Promise.race([runPromise, timeoutPromise]);
    const memoryDelta = Math.max(0, currentRuntimeMemoryBytes() - memoryBefore);
    if (memoryDelta > maxHeapDeltaBytes) {
      return {
        ok: false,
        error: `Runtime memory limit exceeded: ${memoryDelta} > ${maxHeapDeltaBytes} bytes`,
        timedOut: false,
        durationMs: Date.now() - start,
        stdout: output.stdoutText(),
        stderr: output.stderrText(),
        truncatedOutput: output.truncated(),
      };
    }

    return {
      ok: true,
      value,
      timedOut: false,
      durationMs: Date.now() - start,
      stdout: output.stdoutText(),
      stderr: output.stderrText(),
      truncatedOutput: output.truncated(),
    };
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.message === "__HARBOR_RUNTIME_TIMEOUT__"
        || error.message.includes("Script execution timed out"));
    const memoryDelta = Math.max(0, currentRuntimeMemoryBytes() - memoryBefore);
    if (!timedOut && memoryDelta > maxHeapDeltaBytes) {
      return {
        ok: false,
        error: `Runtime memory limit exceeded: ${memoryDelta} > ${maxHeapDeltaBytes} bytes`,
        timedOut: false,
        durationMs: Date.now() - start,
        stdout: output.stdoutText(),
        stderr: output.stderrText(),
        truncatedOutput: output.truncated(),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: timedOut ? `Runtime timed out after ${timeoutMs}ms` : message,
      timedOut,
      durationMs: Date.now() - start,
      stdout: output.stdoutText(),
      stderr: output.stderrText(),
      truncatedOutput: output.truncated(),
    };
  }
}

function currentRuntimeMemoryBytes(): number {
  const usage = process.memoryUsage();
  const external = typeof usage.external === "number" ? usage.external : 0;
  const arrayBuffers = typeof usage.arrayBuffers === "number" ? usage.arrayBuffers : 0;
  return usage.heapUsed + external + arrayBuffers;
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

function createBoundedOutputCollector(limitBytes: number): {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  stdoutText: () => string;
  stderrText: () => string;
  truncated: () => boolean;
} {
  let used = 0;
  let clipped = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const pushChunk = (target: string[], value: string): void => {
    const line = `${value}\n`;
    if (clipped) {
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (used + bytes <= limitBytes) {
      target.push(line);
      used += bytes;
      return;
    }
    const remaining = limitBytes - used;
    if (remaining > 0) {
      target.push(sliceUtf8(line, remaining));
    }
    clipped = true;
  };

  return {
    stdout: (line: string) => pushChunk(stdoutChunks, line),
    stderr: (line: string) => pushChunk(stderrChunks, line),
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
    truncated: () => clipped,
  };
}

function sliceUtf8(input: string, maxBytes: number): string {
  const out: string[] = [];
  let used = 0;
  for (const char of input) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) {
      break;
    }
    out.push(char);
    used += bytes;
  }
  return out.join("");
}
