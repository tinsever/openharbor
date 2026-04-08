import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalRequiredError } from "@openharbor/core";
import { createHarborEnvironment, validateCapabilityPackRegistry } from "@openharbor/host";

async function withTempRepo(
  fn: (paths: { repo: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "openharbor-pack-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "hello.txt"), "base\n", "utf8");
  await fn({ repo, dataDir });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to start server"));
        return;
      }
      resolve(addr.port);
    });
  });
}

describe("capability packs", () => {
  it("registers and validates the default static capability packs", async () => {
    await withTempRepo(async ({ dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const result = validateCapabilityPackRegistry(env.capabilityPacks);
      expect(result.ok).toBe(true);
      expect(result.packCount).toBe(4);
      expect(env.capabilityPacks.map((p) => p.manifest.id)).toEqual([
        "core",
        "http-api",
        "docs",
        "browser-observe",
      ]);
    });
  });

  it("rejects malformed pack metadata in validation", () => {
    expect(() =>
      validateCapabilityPackRegistry([
        {
          manifest: {
            id: "bad",
            version: "1.0.0",
            policyHooks: [],
            artifactContract: {
              kind: "none",
              description: "none",
            },
            capabilities: [],
          },
        } as never,
      ]),
    ).toThrow();
  });

  it("enforces security invariants for non-core packs", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);
      for (const pack of env.capabilityPacks) {
        if (pack.manifest.id === "core") {
          continue;
        }
        for (const capability of pack.manifest.capabilities) {
          expect(capability.effect.effectClass).not.toBe("publish.repo");
          expect(capability.effect.effectClass).not.toBe("destructive.repo");
        }
      }

      await env.invoke(session.id, "browser.observeHtml", {
        html: "<html><head><title>Observe</title></head><body>ok</body></html>",
      });
      await expect(access(path.join(repo, "hello.txt"))).resolves.toBeUndefined();
      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("base\n");
    });
  });

  it("gates http.fetch by policy approval and stores response artifacts", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("hello from http pack");
      });

      try {
        const port = await listen(server);
        const env = createHarborEnvironment(dataDir);
        const session = await env.sessions.createSession(repo);
        const url = `http://127.0.0.1:${port}/health`;

        await expect(env.invoke(session.id, "http.fetch", { url })).rejects.toThrow(
          ApprovalRequiredError,
        );

        const out = (await env.invoke(
          session.id,
          "http.fetch",
          { url },
          { approvedAdapters: new Set(["http:127.0.0.1"]) },
        )) as {
          ok: boolean;
          status: number;
          bodyArtifactId: string;
        };

        expect(out.ok).toBe(true);
        expect(out.status).toBe(200);

        const body = (await env.invoke(session.id, "artifacts.get", {
          artifactId: out.bodyArtifactId,
        })) as { found: boolean; content?: string };
        expect(body.found).toBe(true);
        expect(body.content).toContain("hello from http pack");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("indexes and queries docs artifacts", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const source = (await env.invoke(session.id, "artifacts.put", {
        content: ["alpha line", "beta line", "gamma alpha"].join("\n"),
        mimeType: "text/plain",
      })) as { artifactId: string };

      const indexed = (await env.invoke(session.id, "docs.ingestArtifact", {
        artifactId: source.artifactId,
      })) as { docId: string };

      const queried = (await env.invoke(session.id, "docs.query", {
        docId: indexed.docId,
        query: "alpha",
      })) as {
        found: boolean;
        matches: Array<{ lineNumber: number; line: string }>;
        summaryArtifactId?: string;
      };

      expect(queried.found).toBe(true);
      expect(queried.matches.length).toBeGreaterThan(0);
      expect(queried.summaryArtifactId).toBeTruthy();
    });
  });

  it("observes HTML in browser-observe prototype pack", async () => {
    await withTempRepo(async ({ repo, dataDir }) => {
      const env = createHarborEnvironment(dataDir);
      const session = await env.sessions.createSession(repo);

      const observed = (await env.invoke(session.id, "browser.observeHtml", {
        html: `
          <html>
            <head><title>Sample Page</title></head>
            <body>
              <a href="https://example.com/a">A</a>
              <a href="https://example.com/b">B</a>
              <p>Harbor observation sample text.</p>
            </body>
          </html>
        `,
      })) as {
        title: string | null;
        links: string[];
        textSample: string;
        observationArtifactId: string;
      };

      expect(observed.title).toBe("Sample Page");
      expect(observed.links).toEqual(
        expect.arrayContaining(["https://example.com/a", "https://example.com/b"]),
      );
      expect(observed.textSample.toLowerCase()).toContain("observation sample");
      expect(observed.observationArtifactId).toBeTruthy();
    });
  });
});
