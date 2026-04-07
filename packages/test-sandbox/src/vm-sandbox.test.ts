import { describe, expect, it } from "vitest";
import { evalInTestSandbox, runInTestSandbox } from "./vm-sandbox.js";

describe("evalInTestSandbox", () => {
  it("evaluates arithmetic without host globals", () => {
    expect(evalInTestSandbox("1 + 2")).toBe(3);
  });

  it("receives injected globals", () => {
    expect(
      evalInTestSandbox("x * 2", {
        globals: { x: 21 },
      }),
    ).toBe(42);
  });

  it("does not expose process by default", () => {
    const hasProcess = evalInTestSandbox<boolean>("typeof process !== 'undefined'");
    expect(hasProcess).toBe(false);
  });
});

describe("runInTestSandbox", () => {
  it("runs script body", () => {
    const result = runInTestSandbox<number>("const a = 40; const b = 2; a + b");
    expect(result).toBe(42);
  });
});
