import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityPackDefinition } from "../capability-packs.js";

const browserObserveHtmlInputSchema = z.object({
  html: z.string(),
  url: z.string().url().optional(),
  maxLinks: z.number().int().positive().max(100).default(20),
});

const browserObserveHtmlOutputSchema = z.object({
  title: z.string().nullable(),
  links: z.array(z.string()),
  textSample: z.string(),
  observationArtifactId: z.string(),
});

export const browserObserveCapabilityPack: CapabilityPackDefinition = {
  manifest: {
    id: "browser-observe",
    version: "1.0.0",
    title: "Browser-observe prototype",
    description: "Read-only HTML observation with extracted title, links, and text summary.",
    policyHooks: ["policy_presets", "audit_events"],
    artifactContract: {
      kind: "produces",
      description: "Stores structured observation output as an artifact.",
    },
  },
  register: (host) => {
    const descriptor = host.register({
      name: "browser.observeHtml",
      description: "Observe HTML content and return title/link/text summary",
      effect: { effectClass: "write.artifact" },
      input: browserObserveHtmlInputSchema,
      output: browserObserveHtmlOutputSchema,
      resolveTarget: (_input, session) => ({
        kind: "artifact" as const,
        id: session.id,
      }),
      handler: async (input, ctx) => {
        const titleMatch = input.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch?.[1]?.trim() || null;
        const links = [...input.html.matchAll(/href=["']([^"']+)["']/gi)]
          .map((match) => match[1])
          .filter((value): value is string => typeof value === "string")
          .slice(0, input.maxLinks ?? 20);
        const textSample = input.html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600);

        const observation = {
          title,
          links,
          textSample,
          url: input.url ?? null,
          observedAt: new Date().toISOString(),
        };

        const observationArtifactId = randomUUID();
        await ctx.store.putArtifact(ctx.session.id, {
          id: observationArtifactId,
          mimeType: "application/json",
          content: JSON.stringify(observation, null, 2),
        });

        return {
          title,
          links,
          textSample,
          observationArtifactId,
        };
      },
      inputSchemaId: "browser.observeHtml.input",
      outputSchemaId: "browser.observeHtml.output",
    });

    return [descriptor];
  },
};
