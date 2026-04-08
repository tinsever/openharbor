# Audit Observability Guide

This guide covers OpenHarbor v1 audit schema compatibility, integrity expectations, and incident replay workflows.

## Audit schema migration notes

- **v0 audit events** were unversioned JSONL entries.
- **v1 audit events** include `schemaVersion: 1`.
- Read paths remain backward compatible with v0 entries by normalizing them to the v1 in-memory shape.
- New writes always use `schemaVersion: 1`.

Compatibility expectations:

- Mixed logs (legacy + v1) are supported for read, inspect, search, and replay.
- No destructive migration is required for existing session data.
- Future schema versions should keep a compatibility parser for older events and document normalization behavior.

## Append-only and integrity behavior

Audit logs are append-only during normal operation:

- events are appended line-by-line to `audit.jsonl`
- existing lines are not rewritten by host APIs
- each line includes an integrity envelope (`__integrity`) with a SHA-256 chain

Integrity verification reports:

- `parse_error`: line is not valid JSON/event schema
- `missing_integrity`: integrity metadata missing or malformed
- `chain_mismatch`: `prevHash` does not match the previous event hash
- `hash_mismatch`: event content does not match stored hash

What integrity checks detect:

- out-of-band edits to existing audit lines
- insertion/removal/reordering that breaks the hash chain
- payload tampering on any hashed field

What integrity checks do not claim:

- protection against an attacker who can rewrite the entire file and recompute a full chain
- non-repudiation guarantees beyond local file integrity

## CLI audit commands

Inspect and verify:

```bash
pnpm harbor audit inspect <session-id> --verify
pnpm harbor audit inspect <session-id> --type capability.call --limit 50
pnpm harbor audit inspect <session-id> --from 2026-04-08T00:00:00.000Z --to 2026-04-08T23:59:59.999Z
```

Search:

```bash
pnpm harbor audit search <session-id> --query publish
pnpm harbor audit search <session-id> --query pnpm-test --type capability.result
```

Replay summary:

```bash
pnpm harbor audit replay <session-id>
```

## Incident replay checklist

1. Run `audit inspect --verify` and confirm integrity status.
2. Review model run events (`model_run.started/completed/failed`) to establish execution timeline.
3. Review policy and approval events (`policy.evaluation`, `approval.*`) to understand what was denied/approved and why.
4. Review change and publish events (`overlay.mutated`, `publish.*`) to identify what changed and what reached the repository.
5. Follow artifact references from `capability.result` and test run events to inspect stdout/stderr and related outputs.
6. Use `audit replay` for a condensed session overview and `audit search` for targeted investigation.
