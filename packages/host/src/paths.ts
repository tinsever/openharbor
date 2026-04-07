import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultDataDir(): string {
  const fromEnv = process.env.OPENHARBOR_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".openharbor");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function sessionDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "sessions", sessionId);
}
