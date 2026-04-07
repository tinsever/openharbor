import test from "node:test";
import assert from "node:assert/strict";
import { createHarborRuntime } from "./index.js";

test("runtime can call harbor.invoke and return a value", async () => {
  const runtime = createHarborRuntime();
  const result = await runtime.execute({
    code: `
      const data = await harbor.invoke("repo.readFile", { path: "README.md" });
      return data;
    `,
    bridge: {
      invoke: async (name, input) => ({ name, input }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.value), JSON.stringify({
    name: "repo.readFile",
    input: { path: "README.md" },
  }));
});

test("runtime rejects direct process access", async () => {
  const runtime = createHarborRuntime();
  const result = await runtime.execute({
    code: `
      return process.cwd();
    `,
    bridge: {
      invoke: async () => ({}),
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Cannot read properties of undefined|undefined/);
});

test("runtime enforces timeout", async () => {
  const runtime = createHarborRuntime();
  const result = await runtime.execute({
    code: `
      while (true) {}
    `,
    limits: { timeoutMs: 25 },
    bridge: {
      invoke: async () => ({}),
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out|Script execution timed out/i);
});

test("runtime truncates output with configured limit", async () => {
  const runtime = createHarborRuntime();
  const result = await runtime.execute({
    code: `
      for (let i = 0; i < 50; i += 1) {
        console.log("x".repeat(20));
      }
      return true;
    `,
    limits: { maxOutputBytes: 64 },
    bridge: {
      invoke: async () => ({}),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.truncatedOutput, true);
  assert.ok((result.stdout.length + result.stderr.length) <= 64);
});

test("runtime enforces memory growth limits", async () => {
  const runtime = createHarborRuntime();
  const result = await runtime.execute({
    code: `
      const blobs = [];
      for (let i = 0; i < 96; i += 1) {
        blobs.push(new Uint8Array(1024 * 1024).fill(i));
      }
      return blobs.length;
    `,
    limits: { maxHeapDeltaBytes: 8 * 1024 * 1024 },
    bridge: {
      invoke: async () => ({}),
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /memory limit exceeded/i);
});
