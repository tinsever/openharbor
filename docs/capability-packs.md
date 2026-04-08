# Capability-Pack Developer Guide

Capability packs are the extension point for adding host-owned capabilities without changing Harbor kernel trust boundaries.

## Goals

- Keep capability loading deterministic (static host registration in v1)
- Keep policy decisions centralized in existing preset/rule evaluation
- Require complete capability metadata for every registered capability
- Ensure new packs can be reviewed and validated in CI

## Contract

Each pack provides a manifest and a registration function.

Required manifest fields:

- `id`: stable pack identifier
- `version`: pack contract version
- `policyHooks`: declared policy integration points
- `artifactContract`: whether the pack consumes/produces artifacts and why

Capability metadata requirements:

- unique `name`
- declared `effect.effectClass`
- `inputSchemaId` and `outputSchemaId`
- explicit host-side target resolution via `resolveTarget`

## Registration Flow

1. Define capability handlers and zod input/output schemas.
2. Register capabilities in a pack-local `register(host)` function.
3. Return descriptors from `host.register(...)` calls.
4. Export the pack in `packages/host/src/packs`.
5. Add the pack to the static list in `packages/host/src/packs/index.ts`.
6. Run `pnpm validate:capability-packs`.

## Policy Hook Expectations

- Packs must not implement a parallel policy engine.
- Effect classes must map into existing policy presets.
- Approval-gated behavior should rely on `require_approval` policy outcomes rather than ad hoc prompts.

## Artifact Expectations

- If a capability emits significant output, store it as a session artifact.
- Reference artifact IDs in capability results whenever possible.
- Keep MIME types accurate (`text/plain`, `application/json`, etc.).

## Review Checklist for New Packs

- Does every capability have complete metadata and schema IDs?
- Are effect classes appropriate and minimally privileged?
- Are targets resolved explicitly and auditable?
- Do tests cover allow, deny/approval-required, and artifact linkage paths?
- Does the pack avoid `publish.repo` and `destructive.repo` unless explicitly intended?

## Migration Notes (builtins -> packs)

OpenHarbor moved from a single `registerBuiltinCapabilities` registration entrypoint to static capability packs:

- `core` pack wraps previous built-ins.
- `http-api`, `docs`, and `browser-observe` are prototype non-code packs.
- Bootstrap now registers packs via `registerDefaultCapabilityPacks`.
- CI now enforces metadata completeness through `validate:capability-packs`.

This keeps runtime behavior deterministic while making cross-domain extension explicit and reviewable.
