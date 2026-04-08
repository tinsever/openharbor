import type { CapabilityDescriptor, CapabilityPackManifest } from "@openharbor/schemas";
import { capabilityPackManifestSchema } from "@openharbor/schemas";
import type { CapabilityHost } from "./capability-host.js";

export interface CapabilityPackDefinition {
  manifest: Omit<CapabilityPackManifest, "capabilities">;
  register: (host: CapabilityHost) => CapabilityDescriptor[];
}

export interface RegisteredCapabilityPack {
  manifest: CapabilityPackManifest;
}

export function registerCapabilityPack(
  host: CapabilityHost,
  pack: CapabilityPackDefinition,
): RegisteredCapabilityPack {
  const descriptors = pack.register(host);
  const manifest = capabilityPackManifestSchema.parse({
    ...pack.manifest,
    capabilities: descriptors,
  });
  assertDescriptorIntegrity(host, manifest);
  return { manifest };
}

export function registerCapabilityPacks(
  host: CapabilityHost,
  packs: CapabilityPackDefinition[],
): RegisteredCapabilityPack[] {
  const out = packs.map((pack) => registerCapabilityPack(host, pack));
  assertNoCrossPackCapabilityConflicts(out);
  return out;
}

export function validateCapabilityPackRegistry(
  packs: RegisteredCapabilityPack[],
): { ok: true; packCount: number; capabilityCount: number } {
  assertNoCrossPackCapabilityConflicts(packs);
  let capabilityCount = 0;
  for (const pack of packs) {
    const manifest = capabilityPackManifestSchema.parse(pack.manifest);
    if (manifest.policyHooks.length === 0) {
      throw new Error(`Capability pack ${manifest.id} must declare at least one policy hook`);
    }
    if (manifest.artifactContract.description.trim().length === 0) {
      throw new Error(`Capability pack ${manifest.id} must provide artifact contract description`);
    }
    for (const descriptor of manifest.capabilities) {
      capabilityCount += 1;
      if (!descriptor.inputSchemaId || !descriptor.outputSchemaId) {
        throw new Error(
          `Capability ${manifest.id}/${descriptor.name} must include inputSchemaId and outputSchemaId`,
        );
      }
      if (!descriptor.effect.effectClass) {
        throw new Error(`Capability ${manifest.id}/${descriptor.name} must declare effect.effectClass`);
      }
    }
  }
  return { ok: true, packCount: packs.length, capabilityCount };
}

function assertDescriptorIntegrity(host: CapabilityHost, manifest: CapabilityPackManifest): void {
  const hostDescriptors = new Map(host.listDescriptors().map((item) => [item.name, item]));
  for (const descriptor of manifest.capabilities) {
    const current = hostDescriptors.get(descriptor.name);
    if (!current) {
      throw new Error(
        `Capability pack ${manifest.id} declared ${descriptor.name} but it was not registered`,
      );
    }
    if (current.effect.effectClass !== descriptor.effect.effectClass) {
      throw new Error(
        `Capability ${descriptor.name} effect mismatch: manifest=${descriptor.effect.effectClass} host=${current.effect.effectClass}`,
      );
    }
  }
}

function assertNoCrossPackCapabilityConflicts(
  packs: Array<{ manifest: CapabilityPackManifest }>,
): void {
  const owners = new Map<string, string>();
  for (const pack of packs) {
    for (const descriptor of pack.manifest.capabilities) {
      const previous = owners.get(descriptor.name);
      if (previous && previous !== pack.manifest.id) {
        throw new Error(
          `Capability ${descriptor.name} is declared by both ${previous} and ${pack.manifest.id}`,
        );
      }
      owners.set(descriptor.name, pack.manifest.id);
    }
  }
}
