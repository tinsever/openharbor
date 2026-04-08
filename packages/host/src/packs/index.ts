import type { CapabilityHost } from "../capability-host.js";
import {
  registerCapabilityPacks,
  validateCapabilityPackRegistry,
  type RegisteredCapabilityPack,
} from "../capability-packs.js";
import { browserObserveCapabilityPack } from "./browser-observe.js";
import { coreCapabilityPack } from "./core.js";
import { docsCapabilityPack } from "./docs.js";
import { httpApiCapabilityPack } from "./http-api.js";

export const defaultCapabilityPacks = [
  coreCapabilityPack,
  httpApiCapabilityPack,
  docsCapabilityPack,
  browserObserveCapabilityPack,
];

export function registerDefaultCapabilityPacks(host: CapabilityHost): RegisteredCapabilityPack[] {
  const packs = registerCapabilityPacks(host, defaultCapabilityPacks);
  validateCapabilityPackRegistry(packs);
  return packs;
}
