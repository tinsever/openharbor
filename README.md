# HELP! I'M STUCK!
Read my blog post on this here: https://www.tin-sever.de/blog/bash-successor

# OpenHarbor

Use `Claude Code`, `Codex`, and `Cursor` on your real machine without giving them raw shell.

OpenHarbor is a local-first execution layer for AI coding agents. Model-authored code runs in a constrained runtime, talks to the world only through typed capabilities, stores changes in a draft overlay, and needs explicit approval before anything is published to a repository.

Harbor is opinionated:

- authority is explicit
- draft work is cheap and reversible
- publish is intentional and auditable
- safety comes from architecture, not prompt obedience

## Why this exists

`just-bash` is fast, but it gives agents ambient authority by default.

Worklayer-style script layers are more structured, but they are still centered on letting the agent write scripts against external systems.

Harbor takes a different position:

- local-first authority boundary
- typed capabilities instead of arbitrary shell
- draft-first edits instead of immediate mutation
- explicit policy and approval gates
- append-only audit trails and replayable sessions

## What you get

| | |
|---:|---|
| MCP-first surface | Use Harbor through `Claude Code`, `Codex`, and `Cursor` over MCP `stdio`. |
| Constrained execution | Runtime code can call `harbor.invoke(...)` only; no ambient `process`, `require`, or open network. |
| Draft-first workflow | Edits land in an overlay; review and test before publish. |
| Policy presets | `permissive`, `balanced`, and `strict`. |
| Audit trail | Session state, artifacts, approvals, and append-only audit logs. |
| Extensible packs | Static capability-pack registration with metadata validation and CI enforcement. |

## Status

OpenHarbor is experimental v0 software for local development and testing. APIs and UX may still change.

## Quick start

### 1. Install

```bash
pnpm install
pnpm build
```

### 2. Print MCP config for your client

```bash
pnpm harbor mcp config claude-code
pnpm harbor mcp config codex
pnpm harbor mcp config cursor
```

### 3. Run the MCP server

```bash
pnpm harbor mcp serve
```

If your client spawns MCP servers for you, use the JSON snippet from `harbor mcp config <client>` instead of running the server manually.

## MCP tools

Harbor exposes task-oriented tools rather than a generic capability shell:

- `harbor_get_guide`
- `harbor_open_session`
- `harbor_list_sessions`
- `harbor_get_overview`
- `harbor_read_file`
- `harbor_list_tree`
- `harbor_search_repo`
- `harbor_read_draft`
- `harbor_write_draft`
- `harbor_delete_draft`
- `harbor_diff`
- `harbor_list_test_adapters`
- `harbor_run_tests`
- `harbor_list_test_runs`
- `harbor_get_artifact`
- `harbor_list_approvals`
- `harbor_grant_approval`
- `harbor_revoke_approval`
- `harbor_publish_preview`
- `harbor_publish_apply`
- `harbor_discard_draft`
- `harbor_revise_review`
- `harbor_reject_publish`

Approval flow is always two-step:

1. A gated tool returns `status: "approval_required"`.
2. The client asks the user.
3. The client calls `harbor_grant_approval`.
4. The client retries the original tool.

For the best MCP experience, start with `harbor_start_here` or `harbor_get_guide` when a client is unsure which Harbor tool to call next. The guide response includes a workflow phase, a single `primaryAction`, a short checklist, and follow-up calls so the client can execute the next Harbor step directly instead of reconstructing the flow from scratch.

For large files, `harbor_read_file` and `harbor_read_draft` also accept `startLine` and `maxLines` so a client can read explicit windows instead of relying on clipped display text. For broad repo searches, prefer passing `path` to `harbor_search_repo`; Harbor will now suggest narrower paths when a root search truncates.

## CLI workflow

Harbor still ships a local CLI for direct use and debugging.

```bash
pnpm harbor init ./demo/sample-repo
pnpm harbor sessions list
pnpm harbor sessions inspect <session-id>
pnpm harbor read <session-id> README.md --repo
pnpm harbor write <session-id> notes.txt --content "draft"
pnpm harbor diff <session-id>
pnpm harbor test <session-id> pnpm-test --approve
pnpm harbor review <session-id>
pnpm harbor publish <session-id> --approve --yes
pnpm harbor artifact get <session-id> <artifact-id> --text
```

## API example

```ts
import { createHarborAgentBridge } from "@openharbor/agent-bridge";

const bridge = createHarborAgentBridge({
  dataDir: "/tmp/openharbor-data",
  policyPreset: "balanced",
});

const session = await bridge.openSession({ repoPath: "/path/to/repo" });
if (session.status !== "ok") {
  throw new Error(session.message);
}

await bridge.writeDraftFile({
  sessionId: session.data.id,
  path: "notes.txt",
  content: "draft change",
});

const preview = await bridge.publishPreview({ sessionId: session.data.id });
```

## Repository layout

- `apps/harbor-cli`: Harbor CLI, MCP entrypoint, and Pi compatibility entrypoint
- `packages/agent-bridge`: protocol-agnostic bridge for MCP and shell adapters
- `packages/mcp-server`: Harbor MCP server over `stdio`
- `packages/core`: shared errors and common exports
- `packages/schemas`: zod schemas for effects, policy, sessions, overlay, and audit
- `packages/overlay`: draft overlay and diff support
- `packages/policy`: policy engine and approval logic
- `packages/runtime`: constrained JS runtime
- `packages/host`: sessions, capability host, built-in capabilities, and local store
- `packages/pi-integration`: deprecated compatibility wrapper over the agent bridge
- `packages/test-sandbox`: integration and sandbox tests
- `demo`: sample workflow

## Common commands

| Command | Description |
|---|---|
| `pnpm build` | Build all workspace packages |
| `pnpm test` | Run all tests |
| `pnpm lint` | Run type/lint checks |
| `pnpm harbor` | Run the Harbor CLI |
| `pnpm harbor mcp serve` | Start the Harbor MCP server over `stdio` |
| `pnpm harbor mcp config <client>` | Print client config for `claude-code`, `codex`, or `cursor` |
| `pnpm harbor sessions list` | List local Harbor sessions |
| `pnpm harbor artifact get <session-id> <artifact-id>` | Print a stored artifact |
| `pnpm validate:capability-packs` | Validate capability-pack metadata |
| `pnpm demo` | Run the demo workflow |

## Policy presets

- `permissive`: repo reads, draft edits, artifacts, and adapter execution are allowed by default; publish still requires approval
- `balanced`: repo reads and draft edits are allowed; tests may require approval depending on adapter approval state; publish requires approval
- `strict`: tests and publish require explicit approval; use for tighter team review loops

## Safety model

- Model code runs through `@openharbor/runtime`.
- Runtime code can call only Harbor’s bridge.
- Side effects happen in host-owned capabilities.
- Draft changes stay in overlay state until publish approval.
- Audit logs are append-only and integrity-checked.

## Data location

By default, Harbor writes local data under:

- `~/.openharbor/sessions/<session-id>/session.json`
- `~/.openharbor/sessions/<session-id>/overlay.json`
- `~/.openharbor/sessions/<session-id>/approvals.json`
- `~/.openharbor/sessions/<session-id>/audit.jsonl`

Override with:

```bash
export OPENHARBOR_DATA_DIR=/var/tmp/openharbor-data
```

## Docs

- [Audit Observability Guide](./docs/audit-observability.md)
- [CLI UX Flows](./docs/cli-ux-flows.md)
- [Capability-Pack Developer Guide](./docs/capability-packs.md)
- [MCP Troubleshooting](./docs/mcp-troubleshooting.md)

## Pi compatibility

Pi support remains available as a compatibility surface, but it is no longer Harbor’s lead integration path. New integrations should use the MCP server or `@openharbor/agent-bridge`.

## License

ISC
