/**
 * Runnable walkthrough: session → repo read → overlay write → diff → publish preview → gated publish.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalRequiredError } from "@openharbor/core";
import { createHarborEnvironment } from "@openharbor/host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleRepo = join(__dirname, "sample-repo");
const dataDir = join(__dirname, ".harbor-data");

async function main(): Promise<void> {
  await mkdir(dataDir, { recursive: true });

  console.log("OpenHarbor demo");
  console.log("  sample repo:", sampleRepo);
  console.log("  data dir:   ", dataDir);
  console.log();

  const env = createHarborEnvironment(dataDir);
  const session = await env.sessions.createSession(sampleRepo);
  console.log("Session:", session.id);

  const pkg = await env.invoke(session.id, "repo.readFile", { path: "hello.txt" });
  console.log("repo.readFile(hello.txt):", JSON.stringify(pkg));

  await env.invoke(session.id, "workspace.writeFile", {
    path: "notes-from-agent.txt",
    content: "// draft: suggest a fix here\n",
  });

  const diff = await env.invoke(session.id, "workspace.diff", {});
  console.log(
    "workspace.diff files:",
    (diff as { files: { path: string }[] }).files.map((f) => f.path).join(", "),
  );

  const preview = await env.invoke(session.id, "publish.preview", {});
  console.log("publish.preview:", preview);

  console.log();
  console.log("publish.request (expect policy to require approval)…");
  try {
    await env.invoke(session.id, "publish.request", {});
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      console.log("  → ApprovalRequiredError:", e.message);
    } else {
      throw e;
    }
  }

  const auditTail = (await env.store.readAudit(session.id)).slice(-4);
  console.log();
  console.log("Last audit event types:", auditTail.map((e) => e.type).join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
