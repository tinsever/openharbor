import { z } from "zod";
import { capabilityEffectMetaSchema } from "./effects.js";

/** Envelope for registered capability descriptors (metadata only; handlers live in host). */
export const capabilityDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  effect: capabilityEffectMetaSchema,
  inputSchemaId: z.string().optional(),
  outputSchemaId: z.string().optional(),
});

export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;
