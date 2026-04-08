import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityPackDefinition } from "../capability-packs.js";

type DocsIndex = {
  sourceArtifactId: string;
  lines: string[];
  createdAt: string;
};

const docsIngestInputSchema = z.object({
  artifactId: z.string(),
});

const docsIngestOutputSchema = z.object({
  docId: z.string(),
  lineCount: z.number().int().nonnegative(),
});

const docsQueryInputSchema = z.object({
  docId: z.string(),
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(50).default(5),
});

const docsQueryOutputSchema = z.object({
  found: z.boolean(),
  docId: z.string(),
  matches: z.array(
    z.object({
      lineNumber: z.number().int().positive(),
      line: z.string(),
    }),
  ),
  summaryArtifactId: z.string().optional(),
});

export const docsCapabilityPack: CapabilityPackDefinition = {
  manifest: {
    id: "docs",
    version: "1.0.0",
    title: "Docs prototype",
    description: "Ingest and query document artifacts.",
    policyHooks: ["policy_presets", "audit_events"],
    artifactContract: {
      kind: "consumes_and_produces",
      description: "Consumes source document artifacts and produces index/summary artifacts.",
    },
  },
  register: (host) => {
    const ingestDescriptor = host.register({
      name: "docs.ingestArtifact",
      description: "Index a text artifact for later docs.query operations",
      effect: { effectClass: "write.artifact" },
      input: docsIngestInputSchema,
      output: docsIngestOutputSchema,
      resolveTarget: (input) => ({ kind: "artifact" as const, id: input.artifactId }),
      handler: async (input, ctx) => {
        const source = await ctx.store.getArtifact(ctx.session.id, input.artifactId);
        if (!source) {
          throw new Error(`Artifact not found: ${input.artifactId}`);
        }
        const lines = source.content.split(/\r?\n/);
        const index: DocsIndex = {
          sourceArtifactId: source.id,
          lines,
          createdAt: new Date().toISOString(),
        };
        const docId = randomUUID();
        await ctx.store.putArtifact(ctx.session.id, {
          id: docId,
          mimeType: "application/json",
          content: JSON.stringify(index),
        });
        return {
          docId,
          lineCount: lines.length,
        };
      },
      inputSchemaId: "docs.ingestArtifact.input",
      outputSchemaId: "docs.ingestArtifact.output",
    });

    const queryDescriptor = host.register({
      name: "docs.query",
      description: "Search an indexed document artifact for matching lines",
      effect: { effectClass: "read.artifact" },
      input: docsQueryInputSchema,
      output: docsQueryOutputSchema,
      resolveTarget: (input) => ({ kind: "artifact" as const, id: input.docId }),
      handler: async (input, ctx) => {
        const indexArtifact = await ctx.store.getArtifact(ctx.session.id, input.docId);
        if (!indexArtifact) {
          return {
            found: false,
            docId: input.docId,
            matches: [],
          };
        }

        const index = JSON.parse(indexArtifact.content) as DocsIndex;
        const needle = input.query.toLowerCase();
        const matches = index.lines
          .map((line, idx) => ({ line, lineNumber: idx + 1 }))
          .filter((item) => item.line.toLowerCase().includes(needle))
          .slice(0, input.maxResults ?? 5);

        let summaryArtifactId: string | undefined;
        if (matches.length > 0) {
          const summary = matches.map((item) => `${item.lineNumber}: ${item.line}`).join("\n");
          const artifactId = randomUUID();
          await ctx.store.putArtifact(ctx.session.id, {
            id: artifactId,
            mimeType: "text/plain",
            content: summary,
          });
          summaryArtifactId = artifactId;
        }

        return {
          found: matches.length > 0,
          docId: input.docId,
          matches,
          summaryArtifactId,
        };
      },
      inputSchemaId: "docs.query.input",
      outputSchemaId: "docs.query.output",
    });

    return [ingestDescriptor, queryDescriptor];
  },
};
