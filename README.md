# OpenHarbor

OpenHarbor is a local-first execution layer for coding agents.

It keeps model code constrained, routes side effects through typed capabilities, stores edits in an overlay, and requires explicit approval before publishing to a real repository.

## Status

OpenHarbor is experimental v0 software intended for local development and testing.

## Why Harbor

When Harbor is done, the goal is simple: let agents do real engineering work with high leverage, without giving them ambient machine authority.

### Philosophy

- Authority should be explicit, typed, and reviewable.
- Draft work should be cheap and reversible.
- Publish should be intentional, human-approved, and auditable.
- Safety should come from architecture, not from hoping prompts are followed.

### Why use Harbor instead of just-bash?

`just-bash` is fast and flexible, but it gives agents broad authority by default. One bad command or prompt-injection hit can mutate the wrong thing immediately.

Harbor shifts that model:

- agents call capabilities instead of arbitrary shell
- changes land in an overlay first
- risky effects are policy-gated
- publish requires approval
- every step is logged to an audit trail

So you trade a little raw convenience for much better control and traceability.

### Harbor vs `sm`

If `sm` is shell-first agent execution, Harbor is policy-first agent execution.

- `sm`: optimize for speed and unconstrained tool access
- Harbor: optimize for controlled authority, reviewability, and safer default behavior

Harbor is for teams that want agent automation to scale without turning every run into a trust fall.

## What it does

- Constrained runtime for model-authored task code
- Policy-gated capability host (`allow`, `deny`, `allow_with_limits`, `require_approval`)
- Overlay workspace for draft edits before publish
- Local session store for artifacts, test runs, and audit logs
- CLI workflow for inspect → draft → test → review → publish

## Repository layout

- `apps/harbor-cli` (`@openharbor/harbor-cli`): local `harbor` CLI and Pi extension entrypoint
- `packages/core` (`@openharbor/core`): shared errors and common exports
- `packages/schemas` (`@openharbor/schemas`): zod schemas for effects, policy, sessions, overlay, audit
- `packages/overlay` (`@openharbor/overlay`): in-memory/persisted draft overlay and diff support
- `packages/policy` (`@openharbor/policy`): policy engine and approval grant handling
- `packages/runtime` (`@openharbor/runtime`): constrained VM runtime + limits
- `packages/host` (`@openharbor/host`): sessions, capability host, built-in capabilities, local store
- `packages/pi-integration` (`@openharbor/pi-integration`): bridge layer for Pi integration
- `packages/test-sandbox` (`@openharbor/test-sandbox`): sandbox helpers and integration tests
- `demo` (`@openharbor/demo`): sample end-to-end run against a demo repo

## Requirements

- Node.js 20+
- pnpm 9+ (repo uses `pnpm@10.x`)

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Common commands

| Command | Description |
|---|---|
| `pnpm build` | Build all workspace packages via Turborepo |
| `pnpm test` | Run all tests |
| `pnpm lint` | Run configured type/lint checks |
| `pnpm demo` | Run demo workflow in `demo/` |
| `pnpm harbor` | Run Harbor CLI |

## Quick start (API)

```ts
import { createHarborEnvironment } from "@openharbor/host";

const env = createHarborEnvironment();
const session = await env.sessions.createSession("/path/to/repo");

await env.invoke(session.id, "repo.readFile", { path: "README.md" });
await env.invoke(session.id, "workspace.writeFile", {
  path: "notes.txt",
  content: "draft",
});

const preview = await env.invoke(session.id, "publish.preview", {});
```

## Quick start (CLI)

```bash
pnpm build
pnpm harbor init ./demo/sample-repo
```

Then run commands with the session id returned by `init`:

```bash
pnpm harbor read <session-id> hello.txt
pnpm harbor write <session-id> notes.txt --content "draft change"
pnpm harbor delete <session-id> packages
pnpm harbor diff <session-id>
pnpm harbor test <session-id> pnpm-test --approve
pnpm harbor publish <session-id> --approve --yes
```

## Runtime and safety model

- Model code runs through `@openharbor/runtime` and can call only `harbor.invoke(...)`.
- Direct access to ambient authority (`process`, `require`, timers, fetch/network primitives) is blocked in runtime context.
- Runtime enforces code size, timeout, output limits, and memory growth limits.
- Side effects are performed by host capabilities, not by runtime scripts directly.
- Publish operations require approval based on policy evaluation.

## Data location

By default, OpenHarbor writes local data under:

- `~/.openharbor/sessions/<session-id>/session.json`
- `~/.openharbor/sessions/<session-id>/overlay.json`
- `~/.openharbor/sessions/<session-id>/audit.jsonl`

Override with:

```bash
export OPENHARBOR_DATA_DIR=/var/tmp/harbor-data
```

## Demo

```bash
pnpm demo
```

See `demo/README.md` for the step-by-step walkthrough.

## License

ISC
