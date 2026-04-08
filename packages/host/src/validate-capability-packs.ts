import { createHarborEnvironment } from "./bootstrap.js";
import { validateCapabilityPackRegistry } from "./capability-packs.js";

async function main(): Promise<void> {
  const env = createHarborEnvironment({
    dataDir: process.env.OPENHARBOR_DATA_DIR ?? "/tmp/openharbor-validate-capability-packs",
  });
  const result = validateCapabilityPackRegistry(env.capabilityPacks);
  process.stdout.write(
    `${JSON.stringify({ ok: true, packCount: result.packCount, capabilityCount: result.capabilityCount })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
