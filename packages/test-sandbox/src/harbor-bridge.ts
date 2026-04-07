import type { HarborEnvironment } from "@openharbor/host";

/**
 * Minimal invoke-shaped bridge for tests. Safe to pass into {@link evalInTestSandbox} globals
 * when you want sandboxed code to call Harbor capabilities (async results must be handled outside the VM).
 */
export function createHarborInvokeBridge(env: HarborEnvironment, sessionId: string) {
  return {
    invoke(name: string, input: unknown) {
      return env.invoke(sessionId, name, input);
    },
  };
}
