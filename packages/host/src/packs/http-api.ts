import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import type { CapabilityPackDefinition } from "../capability-packs.js";

const httpFetchInputSchema = z.object({
  url: z.string().url(),
  method: z.string().default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
});

const httpFetchOutputSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  statusText: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  bodyArtifactId: z.string(),
  bodySizeBytes: z.number().int().nonnegative(),
});

export const httpApiCapabilityPack: CapabilityPackDefinition = {
  manifest: {
    id: "http-api",
    version: "1.0.0",
    title: "HTTP/API prototype",
    description: "Fetch HTTP responses through typed capability with artifact capture.",
    policyHooks: ["approval_grants", "policy_presets", "audit_events"],
    artifactContract: {
      kind: "produces",
      description: "Stores HTTP response body as a session artifact.",
    },
  },
  register: (host) => {
    const descriptor = host.register({
      name: "http.fetch",
      description: "Fetch a URL and store the response body as an artifact",
      effect: { effectClass: "execute.adapter", requiresApprovalByDefault: true },
      input: httpFetchInputSchema,
      output: httpFetchOutputSchema,
      resolveTarget: (input) => {
        const url = new URL(input.url);
        return {
          kind: "adapter" as const,
          id: `http:${url.hostname}`,
          path: url.pathname || "/",
        };
      },
      handler: async (input, ctx) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
        try {
          const response = await fetch(input.url, {
            method: input.method,
            headers: input.headers,
            body: input.body,
            signal: controller.signal,
          });
          const body = await response.text();
          const artifactId = randomUUID();
          const saved = await ctx.store.putArtifact(ctx.session.id, {
            id: artifactId,
            mimeType: response.headers.get("content-type") ?? "text/plain",
            content: body,
          });

          const headers: Record<string, string> = {};
          for (const [k, v] of response.headers.entries()) {
            headers[k] = v;
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers,
            bodyArtifactId: saved.id,
            bodySizeBytes: saved.sizeBytes,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      inputSchemaId: "http.fetch.input",
      outputSchemaId: "http.fetch.output",
    });

    return [descriptor];
  },
};
