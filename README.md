# OpenHarbor

Let coding agents do real work on your machine—without handing them the keys.

OpenHarbor is a local-first execution layer for AI coding agents. Model-authored code runs in a constrained runtime, talks to the world only through typed capabilities, stores changes in a draft overlay, and needs explicit human approval before anything touches a real repository.

If you want agent automation that scales for a team—reviewable, policy-gated, and auditable—Harbor is built for that trade-off: a bit less raw shell freedom for a lot more control and traceability.


## Who it’s for

- Teams running agents against real repos who need guardrails, not blind trust in prompts.
- Individuals who want draft → test → review → publish instead of silent disk mutations.
- Integrators (e.g. Pi) who need a stable host for sessions, policy, overlay, and audit—not ad hoc scripts.


## What you get

| | |
|---:|---|
| Constrained execution | Agents call `harbor.invoke(...)` only—no ambient `process`, open network, or arbitrary `require` in the runtime sandbox. |
| Policy, not vibes | Allow / deny / limits / require approval—plus presets (`permissive`, `balanced`, `strict`). |
| Draft-first workflow | Edits land in an overlay; you diff, test, and approve before publish. |
| Audit trail | Session data and append-only logs so you can inspect and replay what happened. |
| CLI + API | Same model from `pnpm harbor` or `@openharbor/host` in your own tooling. |


## Status

OpenHarbor is experimental v0 software—intended for local development and testing. APIs and behavior may change.


## Why Harbor

When Harbor is mature, the goal is simple: high-leverage agent engineering without ambient machine authority.

### Philosophy

- Authority should be explicit, typed, and reviewable.
- Draft work should be cheap and reversible.
- Publish should be intentional, human-approved, and auditable.
- Safety should come from architecture, not from hoping prompts are followed.

### Harbor vs “just give it bash”

`just-bash` is fast and flexible, but it gives agents broad authority by default. One bad command or prompt-injection hit can mutate the wrong thing immediately.

Harbor shifts that model:

- Agents call capabilities instead of arbitrary shell.
- Changes land in an overlay first.
- Risky effects are policy-gated.
- Publish requires approval.
- Every step is logged to an audit trail.

You trade a little raw convenience for much better control and traceability.

### Harbor vs `sm`

If `sm` is shell-first agent execution, Harbor is policy-first agent execution.

- `sm`: optimize for speed and unconstrained tool access.
- Harbor: optimize for controlled authority, reviewability, and safer defaults.

Harbor fits teams that want agent automation to scale without every run being a trust fall.


## What it does (feature list)

- Constrained runtime for model-authored task code
- Policy-gated capability host (`allow`, `deny`, `allow_with_limits`, `require_approval`)
- Built-in policy presets: `permissive`, `balanced`, `strict`
- Overlay workspace for draft edits before publish
- Local session store for artifacts, test runs, and audit logs
- CLI workflow: inspect → draft → test → review → publish


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


## Policy presets

- `permissive`: repo reads, draft edits, artifacts, and test adapters are allowed by default; publish still requires approval
- `balanced`: same defaults, but test adapters must be in the approved adapter set or explicitly approved
- `strict`: same defaults, but every test adapter run requires explicit approval even if the adapter is otherwise approved


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

You can choose a preset when creating the environment:

```ts
const env = createHarborEnvironment({
  dataDir: "/tmp/openharbor-data",
  policyPreset: "strict",
});
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
pnpm harbor audit inspect <session-id> --verify
pnpm harbor audit replay <session-id>
pnpm harbor publish <session-id> --approve --yes
```

Preset selection is available in the CLI too:

```bash
pnpm harbor init ./demo/sample-repo --policy-preset strict
OPENHARBOR_POLICY_PRESET=permissive pnpm harbor test <session-id> pnpm-test
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


## Audit and replay workflow

See [Audit Observability Guide](./docs/audit-observability.md) for:

- audit schema version migration notes
- append-only and integrity guarantees
- incident-style replay steps (`inspect`, `search`, `replay`)

See [CLI UX Flows](./docs/cli-ux-flows.md) for the top 10 end-to-end CLI workflow checks used for UX validation.


## License

ISC
